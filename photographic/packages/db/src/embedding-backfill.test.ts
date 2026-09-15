/**
 * The embedding backfill, against a real local Postgres. Skipped rather than failed when
 * no database is reachable; see `postgres-services.test.ts` for why.
 *
 * Three properties, each of which is the difference between a backfill that can be
 * trusted to run unattended over everything a person has ever saved and one that cannot:
 * it resumes, it does not pay twice, and its progress is a fact about the data rather
 * than something inferred from a log line.
 *
 * Plus the fourth, which was a promise made in writing: every memory whose text was sent
 * to a model records which model, and the backfill records it for memories saved long
 * before the model was switched on — otherwise "how do you know that about me?" is
 * complete only for new memories.
 */

import { randomUUID } from 'node:crypto';

import type { LlmPort } from '@photographic/core';
import { FakeLlm } from '@photographic/core/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  embeddingBackfillProgress,
  runEmbeddingBackfillBatch,
} from './embedding-backfill.js';
import { createPool, databaseUrl } from './pool.js';
import { createPostgresServices, type PostgresServices } from './postgres-services.js';

/**
 * A second embedding provider, exercised through the same port.
 *
 * The point of this class is that it is *not* a stub of `OpenAiLlm` — it is a different
 * provider identity with a different model name, wired in through nothing but the
 * constructor argument `createPostgresServices` already takes. If swapping a provider
 * required touching anything below that seam, this file would not compile, which is a
 * stronger statement than reading the interface and concluding it looks swappable.
 *
 * It answers in 1536 dimensions because that is what the frozen schema's `vector(1536)`
 * columns hold. A provider with a different native dimension count (Mistral's
 * `mistral-embed` is 1024) is a migration plus a re-embed rather than a configuration
 * change, and that is the honest size of a move to a European provider.
 */
class SecondProviderLlm implements LlmPort {
  private readonly inner = new FakeLlm(1536);

  embeddingIdentity() {
    return { provider: 'other-vendor', model: 'other-embed-v1', external: true };
  }

  embed(texts: string[]) {
    return this.inner.embed(texts);
  }
  extractFacts(input: { text: string; existing: string[] }) {
    return this.inner.extractFacts(input);
  }
  compare(a: string, b: string) {
    return this.inner.compare(a, b);
  }
  summarise(input: { texts: string[]; budgetTokens: number }) {
    return this.inner.summarise(input);
  }
}

/** Counts calls, so "did it pay twice" is measurable rather than argued. */
class CountingLlm implements LlmPort {
  embedCalls = 0;
  embeddedTexts: string[] = [];
  private readonly inner = new FakeLlm(1536);

  embeddingIdentity() {
    return { provider: 'counting', model: 'counting-embed', external: true };
  }

  async embed(texts: string[]) {
    this.embedCalls += 1;
    this.embeddedTexts.push(...texts);
    return this.inner.embed(texts);
  }
  extractFacts(input: { text: string; existing: string[] }) {
    return this.inner.extractFacts(input);
  }
  compare(a: string, b: string) {
    return this.inner.compare(a, b);
  }
  summarise(input: { texts: string[]; budgetTokens: number }) {
    return this.inner.summarise(input);
  }
}

let pool: Pool | null = null;
let wired: PostgresServices | null = null;

async function databaseReachable(): Promise<boolean> {
  const probe = createPool({ connectionString: databaseUrl(), max: 1 });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}

beforeAll(async () => {
  if (!(await databaseReachable())) return;
  pool = createPool({ connectionString: databaseUrl() });
  wired = await createPostgresServices({ pool, baseUrl: 'https://photographic.test', log: () => {} });
});

afterAll(async () => {
  await wired?.close();
});

const itIfDb = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!wired) ctx.skip();
    await fn();
  });

/**
 * Memories with no vector at all — the state every memory saved before the model was
 * switched on is in. Written through the real path, then stripped, because a row
 * inserted by hand would not prove the backfill finds what ingest produces.
 */
async function personWithUnembeddedMemories(bodies: string[]) {
  const email = `backfill-test-${randomUUID()}@example.com`;
  const { person, personalRoom } = await wired!.services.identity.register({
    email,
    displayName: 'Emil',
  });
  const actor = wired!.actorFor(person.id, 'claude-desktop');

  const ids: string[] = [];
  for (const body of bodies) {
    const saved = await wired!.services.ingest.remember(actor, {
      roomId: personalRoom.id,
      body,
      kind: 'fact',
      explicit: true,
    });
    if (saved.outcome !== 'auto') throw new Error(`expected a save, got ${saved.outcome}`);
    ids.push(saved.item.id);
  }

  await pool!.query(
    `UPDATE app.item
     SET embedding = NULL, embedding_model = NULL, embedding_provider = NULL, embedded_at = NULL
     WHERE id = ANY($1::uuid[])`,
    [ids],
  );

  return { actor, personalRoom, ids };
}

/**
 * Runs the backfill until the given rows carry the expected provider.
 *
 * The database is shared between test files by design (see `AGENTS.md`), so a single
 * batch is not guaranteed to reach one particular row — it processes oldest-first across
 * everything. Looping is what makes this assert about the provider rather than about
 * which rows happened to be oldest at the time.
 */
async function embedUntilProvider(
  ids: string[],
  llm: Parameters<typeof runEmbeddingBackfillBatch>[1],
  provider: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await embeddingRowsFor(ids);
    if (rows.every((row) => row.embedding_provider === provider)) return;
    const result = await runEmbeddingBackfillBatch(pool!, llm, { batchSize: 200 });
    if (result.embedded === 0) break;
  }
  throw new Error(`rows never reached provider ${provider}`);
}

async function embeddingRowsFor(ids: string[]) {
  const { rows } = await pool!.query<{
    id: string;
    has_vector: boolean;
    embedding_model: string | null;
    embedding_provider: string | null;
    embedded_at: Date | null;
  }>(
    `SELECT id, embedding IS NOT NULL AS has_vector, embedding_model, embedding_provider, embedded_at
     FROM app.item WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

describe('the embedding backfill', () => {
  itIfDb('embeds memories saved before the model was switched on', async () => {
    const llm = new CountingLlm();
    const { ids } = await personWithUnembeddedMemories([
      'Allergisk mot ketchup sedan barnsben',
      'Dottern Vera fyller år i februari',
      'Bor i Göteborg sedan flytten',
    ]);

    const result = await runEmbeddingBackfillBatch(pool!, llm, { batchSize: 10 });

    expect(result.embedded).toBeGreaterThanOrEqual(3);
    const rows = await embeddingRowsFor(ids);
    expect(rows.every((row) => row.has_vector)).toBe(true);
  });

  itIfDb('records which model saw the text, for old memories too', async () => {
    // The promise this closes: a person asking "hur vet du det om mig?" can reach the
    // fact that their text went to a model. It has to hold for a memory saved months
    // before the model existed, not only for new ones.
    const llm = new CountingLlm();
    const { ids } = await personWithUnembeddedMemories(['Kör en Volvo V60 från 2019']);

    await runEmbeddingBackfillBatch(pool!, llm, { batchSize: 10 });

    const [row] = await embeddingRowsFor(ids);
    expect(row!.embedding_provider).toBe('counting');
    expect(row!.embedding_model).toBe('counting-embed');
    expect(row!.embedded_at).toBeTruthy();
  });

  itIfDb('is resumable: interrupting it loses nothing and repeats nothing', async () => {
    const llm = new CountingLlm();
    const { ids } = await personWithUnembeddedMemories([
      'Spelar innebandy på onsdagar',
      'Föredrar tåg framför flyg inom Sverige',
      'Har en bror som heter Elias',
      'Läser mest facklitteratur',
    ]);

    // One batch, then "crash" — nothing is persisted about where it got to, because
    // there is nothing to persist.
    const first = await runEmbeddingBackfillBatch(pool!, llm, { batchSize: 2 });
    expect(first.embedded).toBe(2);

    const afterFirst = await embeddingRowsFor(ids);
    const doneEarly = afterFirst.filter((row) => row.has_vector).map((row) => row.id);
    expect(doneEarly).toHaveLength(2);

    // A fresh run, as though the process had restarted.
    const textsBefore = [...llm.embeddedTexts];
    await runEmbeddingBackfillBatch(pool!, llm, { batchSize: 10 });
    const newlySent = llm.embeddedTexts.slice(textsBefore.length);

    expect((await embeddingRowsFor(ids)).every((row) => row.has_vector)).toBe(true);
    // And the two it had already done were not sent again — the resumption is what
    // stops a restart from being a second invoice.
    expect(newlySent).toHaveLength(2);
  });

  itIfDb('does not send the same memory twice when run again after finishing', async () => {
    const llm = new CountingLlm();
    const { ids } = await personWithUnembeddedMemories(['Tycker inte om att prata i telefon']);

    await runEmbeddingBackfillBatch(pool!, llm, { batchSize: 10 });
    const sentAfterFirst = llm.embeddedTexts.length;

    const second = await runEmbeddingBackfillBatch(pool!, llm, { batchSize: 10 });

    expect(second.embedded).toBe(0);
    expect(llm.embeddedTexts).toHaveLength(sentAfterFirst);
    expect((await embeddingRowsFor(ids))[0]!.has_vector).toBe(true);
  });

  itIfDb('treats a vector from the deterministic fake as work still to do', async () => {
    // The first real run's actual job. Everything embedded while `PHOTOGRAPHIC_LLM` was
    // unset carries a hash with no semantic content, and a backfill that counted those
    // as done would report success without making anything findable by meaning.
    const { ids } = await personWithUnembeddedMemories(['Jobbar med förvärv på Buyersclub']);

    await runEmbeddingBackfillBatch(pool!, new FakeLlm(1536), { batchSize: 10 });
    const afterFake = await embeddingRowsFor(ids);
    expect(afterFake[0]!.embedding_provider).toBe('fake');

    const real = new CountingLlm();
    const progress = await embeddingBackfillProgress(pool!, real);
    expect(progress.stale).toBeGreaterThan(0);

    await runEmbeddingBackfillBatch(pool!, real, { batchSize: 10 });
    const afterReal = await embeddingRowsFor(ids);
    expect(afterReal[0]!.embedding_provider).toBe('counting');
  });

  itIfDb('reports progress as a count of the data, not as a claim', async () => {
    const llm = new CountingLlm();
    const { ids } = await personWithUnembeddedMemories([
      'Dricker kaffe svart',
      'Sover dåligt vid fullmåne',
    ]);

    const before = await embeddingBackfillProgress(pool!, llm);
    expect(before.remaining).toBeGreaterThanOrEqual(2);
    expect(before.done).toBe(false);
    expect(before.model).toBe('counting-embed');

    let guard = 0;
    while ((await embeddingBackfillProgress(pool!, llm)).remaining > 0 && guard < 200) {
      await runEmbeddingBackfillBatch(pool!, llm, { batchSize: 50 });
      guard += 1;
    }

    const after = await embeddingBackfillProgress(pool!, llm);
    expect(after.done).toBe(true);
    expect(after.remaining).toBe(0);
    expect((await embeddingRowsFor(ids)).every((row) => row.has_vector)).toBe(true);
  });

  itIfDb('leaves a deleted memory alone rather than paying to embed the trash', async () => {
    const llm = new CountingLlm();
    const { actor, personalRoom, ids } = await personWithUnembeddedMemories([
      'Ett minne som ska bort',
    ]);
    const shortId = (
      await pool!.query<{ short_id: string }>(`SELECT short_id FROM app.item WHERE id = $1`, [
        ids[0],
      ])
    ).rows[0]!.short_id;

    await wired!.services.ingest.forget(actor, shortId as never, personalRoom.id);

    const before = llm.embeddedTexts.length;
    await runEmbeddingBackfillBatch(pool!, llm, { batchSize: 10 });

    expect(llm.embeddedTexts.slice(before)).not.toContain('Ett minne som ska bort');
    expect((await embeddingRowsFor(ids))[0]!.has_vector).toBe(false);
  });
});

/**
 * Condition 1 of the embedding decision: the provider stays swappable, verified by
 * running a second one through the same port rather than by trusting the interface.
 *
 * What makes this a real check and not a tautology: `SecondProviderLlm` is constructed
 * and handed to `createPostgresServices` as `llm`, and nothing else in the call changes.
 * If swapping a provider required a change below that seam — in ingest, in retrieval, in
 * the backfill, in the schema — this would not pass, and the one-column-backfill property
 * the design claims would be false.
 */
describe('swapping the embedding provider', () => {
  itIfDb('needs nothing but the constructor argument', async () => {
    const swapped = await createPostgresServices({
      pool: pool!,
      baseUrl: 'https://photographic.test',
      llm: new SecondProviderLlm(),
      log: () => {},
    });

    const email = `swap-test-${randomUUID()}@example.com`;
    const { person, personalRoom } = await swapped.services.identity.register({
      email,
      displayName: 'Emil',
    });
    const actor = swapped.actorFor(person.id, 'claude-desktop');

    const saved = await swapped.services.ingest.remember(actor, {
      roomId: personalRoom.id,
      body: 'Föredrar korta svar utan inledande artighetsfraser',
      kind: 'preference',
      explicit: true,
    });
    if (saved.outcome !== 'auto') throw new Error('expected a save');

    // The write path, the deferred embed job and the provenance record all go through
    // the swapped provider without anything else being told about it.
    await swapped.runJobsToCompletion();

    const [row] = await embeddingRowsFor([saved.item.id]);
    expect(row!.has_vector).toBe(true);
    expect(row!.embedding_provider).toBe('other-vendor');
    expect(row!.embedding_model).toBe('other-embed-v1');

    // And search still works against it, which is the half that would break if the
    // vector had been written in a shape the read path did not expect.
    const hits = await swapped.services.retrieval.search(actor, { query: 'korta svar' });
    expect(hits.some((hit) => hit.text.includes('korta svar'))).toBe(true);

    // The backfill is provider-agnostic in the same way: asked about a different
    // provider's model, the same rows read as work to do.
    const progressForOther = await embeddingBackfillProgress(pool!, new CountingLlm());
    expect(progressForOther.stale).toBeGreaterThan(0);
  });

  itIfDb('discloses an external provider and does not over-disclose a local one', async () => {
    // The allowlist direction that matters: an unclassified provider reads as external,
    // because claiming text stayed local when it did not is the failure worth avoiding.
    const { actor, personalRoom, ids } = await personWithUnembeddedMemories([
      'Allergisk mot skaldjur',
    ]);
    const shortId = (
      await pool!.query<{ short_id: string }>(`SELECT short_id FROM app.item WHERE id = $1`, [
        ids[0],
      ])
    ).rows[0]!.short_id;

    await embedUntilProvider(ids, new SecondProviderLlm(), 'other-vendor');
    const external = await wired!.services.history.provenance(
      actor,
      shortId as never,
      personalRoom.id,
    );
    expect(external!.embedding).toMatchObject({
      provider: 'other-vendor',
      model: 'other-embed-v1',
      external: true,
    });

    await embedUntilProvider(ids, new FakeLlm(1536), 'fake');
    const local = await wired!.services.history.provenance(
      actor,
      shortId as never,
      personalRoom.id,
    );
    expect(local!.embedding).toMatchObject({ provider: 'fake', external: false });
  });

  itIfDb('says nothing about a memory whose text no model has seen', async () => {
    const { actor, personalRoom, ids } = await personWithUnembeddedMemories([
      'Ett minne utan vektor',
    ]);
    const shortId = (
      await pool!.query<{ short_id: string }>(`SELECT short_id FROM app.item WHERE id = $1`, [
        ids[0],
      ])
    ).rows[0]!.short_id;

    const provenance = await wired!.services.history.provenance(
      actor,
      shortId as never,
      personalRoom.id,
    );

    // Null rather than a reassuring sentence: no vector was computed, so there is
    // nothing to say, and inventing "stayed local" would be a claim about a call that
    // never happened.
    expect(provenance!.embedding).toBeNull();
  });
});
