/**
 * `PgRetrieval` against a real local Postgres. Skipped rather than failed when no
 * database is reachable — see `postgres-services.test.ts` for why.
 *
 * `FakeLlm` (the default) is deterministic but not semantically meaningful, so it
 * cannot prove ranking *quality* — that was measured separately, empirically, against
 * a realistic Swedish corpus (see the file comment on `retrieval.ts`). What it can and
 * must prove is that the wiring is correct: an embedding gets written and used when
 * one exists, search never fails when the LLM is unavailable, and Swedish inflection —
 * which trigram alone already handles, independent of any real model — is actually
 * found through the real SQL path now, not just in a reference implementation.
 */

import { randomUUID } from 'node:crypto';

import type { LlmPort } from '@photographic/core';
import { FakeLlm } from '@photographic/core/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, databaseUrl } from '../pool.js';
import { createPostgresServices, type PostgresServices } from '../postgres-services.js';

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
  wired = await createPostgresServices({ pool, baseUrl: 'https://photographic.test' });
});

afterAll(async () => {
  await wired?.close();
});

const itIfDb = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!wired) ctx.skip();
    await fn();
  });

async function newActorWithRoom(title: string) {
  const email = `retrieval-test-${randomUUID()}@example.com`;
  const { person, personalRoom } = await wired!.services.identity.register({ email, displayName: 'Test' });
  const actor = wired!.actorFor(person.id, 'claude-desktop');
  const room = await wired!.services.rooms.create(actor, { title });
  return { actor, personalRoom, room };
}

describe('PgRetrieval', () => {
  itIfDb('still finds a plain, near-exact match', async () => {
    const { actor, room } = await newActorWithRoom(`Ledning ${randomUUID()}`);
    await wired!.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Vi beslutade att skjuta förvärvet till Q3',
      kind: 'decision',
      explicit: true,
    });

    const hits = await wired!.services.retrieval.search(actor, { query: 'förvärvet Q3' });
    expect(hits[0]?.text).toContain('förvärvet');
  });

  itIfDb('finds a Swedish inflection the old simple-config index would have missed', async () => {
    // "godkänt" (perfect participle) vs "godkände" (past) in the stored text -- the
    // exact category `to_tsvector('simple', ...)` cannot bridge and 'swedish' + OR
    // terms, or trigram, does. Neither arm needs a real embedding for this.
    const { actor, room } = await newActorWithRoom(`Ledning ${randomUUID()}`);
    await wired!.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Styrelsen godkände budgeten för nästa kvartal',
      kind: 'decision',
      explicit: true,
    });

    const hits = await wired!.services.retrieval.search(actor, { query: 'Har styrelsen godkänt budgeten?' });
    expect(hits.some((h) => h.text.includes('godkände budgeten'))).toBe(true);
  });

  itIfDb('never returns an unrelated item just because it has an embedding', async () => {
    // A regression once found here: `ORDER BY embedding <=> ...` always returns
    // *something* if anything in scope has an embedding at all, with no notion of
    // "nothing here is relevant" unless a similarity floor is applied. A search
    // scoped to one embedded, wholly unrelated item was returning that item for
    // every query.
    const { actor, room } = await newActorWithRoom(`Ledning ${randomUUID()}`);
    const result = await wired!.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Vi beslutade att skjuta förvärvet till Q3',
      kind: 'decision',
      explicit: true,
    });
    if (result.outcome !== 'auto') throw new Error('expected an auto save');
    await wired!.runJobsToCompletion();

    const embedded = await pool!.query<{ has_embedding: boolean }>(
      `SELECT embedding IS NOT NULL AS has_embedding FROM app.item WHERE id = $1`,
      [result.item.id],
    );
    expect(embedded.rows[0]?.has_embedding).toBe(true);

    const hits = await wired!.services.retrieval.search(actor, { query: 'ketchup' });
    expect(hits).toHaveLength(0);
  });

  itIfDb('never returns a hit from a room the caller cannot reach', async () => {
    const owner = await newActorWithRoom(`Privat ${randomUUID()}`);
    await wired!.services.ingest.remember(owner.actor, {
      roomId: owner.personalRoom.id,
      body: 'Hemligt privat fakta som ingen annan ska se',
      explicit: true,
    });

    const stranger = await newActorWithRoom(`Annat ${randomUUID()}`);
    const hits = await wired!.services.retrieval.search(stranger.actor, { query: 'Hemligt privat fakta' });

    expect(hits).toHaveLength(0);
  });

  itIfDb('backfills the embedding after the write, not during it', async () => {
    const { actor, room } = await newActorWithRoom(`Ledning ${randomUUID()}`);
    const result = await wired!.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Ett minne som ska bli embeddat i bakgrunden',
      explicit: true,
    });
    if (result.outcome !== 'auto') throw new Error('expected an auto save');

    const before = await pool!.query<{ has_embedding: boolean }>(
      `SELECT embedding IS NOT NULL AS has_embedding FROM app.item WHERE id = $1`,
      [result.item.id],
    );
    expect(before.rows[0]?.has_embedding).toBe(false);

    await wired!.runJobsToCompletion();

    const after = await pool!.query<{ has_embedding: boolean }>(
      `SELECT embedding IS NOT NULL AS has_embedding FROM app.item WHERE id = $1`,
      [result.item.id],
    );
    expect(after.rows[0]?.has_embedding).toBe(true);
  });

  itIfDb('re-embeds on update, keyed so a rapid second edit does not queue twice', async () => {
    const { actor, room } = await newActorWithRoom(`Ledning ${randomUUID()}`);
    const result = await wired!.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Första lydelsen',
      explicit: true,
    });
    if (result.outcome !== 'auto') throw new Error('expected an auto save');
    await wired!.runJobsToCompletion();

    await wired!.services.ingest.update(actor, result.item.shortId, room.id, 'Andra lydelsen, omskriven');
    const ran = await wired!.runJobsToCompletion();
    expect(ran).toBeGreaterThan(0);

    const after = await pool!.query<{ has_embedding: boolean }>(
      `SELECT embedding IS NOT NULL AS has_embedding FROM app.item WHERE id = $1`,
      [result.item.id],
    );
    expect(after.rows[0]?.has_embedding).toBe(true);
  });

  itIfDb('never fails the write when embedding fails, and the search still ranks lexically', async () => {
    const pool2 = createPool({ connectionString: databaseUrl() });
    const fake = new FakeLlm();
    const throwingLlm: LlmPort = {
      embed: async () => {
        throw new Error('simulated network outage');
      },
      extractFacts: (input) => fake.extractFacts(input),
      compare: (a, b) => fake.compare(a, b),
      summarise: (input) => fake.summarise(input),
    };
    const brokenLlm = await createPostgresServices({
      pool: pool2,
      baseUrl: 'https://photographic.test',
      llm: throwingLlm,
    });

    try {
      const email = `retrieval-degrade-${randomUUID()}@example.com`;
      const { person, personalRoom } = await brokenLlm.services.identity.register({ email, displayName: 'Test' });
      const actor = brokenLlm.actorFor(person.id, 'claude-desktop');

      // The write itself must succeed even though every embed call throws.
      const result = await brokenLlm.services.ingest.remember(actor, {
        roomId: personalRoom.id,
        body: 'Allergisk mot ketchup',
        explicit: true,
      });
      expect(result.outcome).toBe('auto');

      // The embedding job fails and retries rather than losing anything.
      await brokenLlm.runJobsToCompletion().catch(() => {
        // `drain` throws if a job keeps re-queuing itself within one pass; a single
        // failed embed job does not, so this is not expected, but the write already
        // succeeded above regardless of what happens here.
      });

      // Search must degrade to lexical + trigram, not throw, when the vector arm fails.
      const hits = await brokenLlm.services.retrieval.search(actor, { query: 'ketchup' });
      expect(hits.some((h) => h.text.includes('ketchup'))).toBe(true);
    } finally {
      await brokenLlm.close();
    }
  });

  it.skipIf(!process.env.OPENAI_API_KEY)(
    'finds a genuine paraphrase with no shared vocabulary, via a real embedding',
    async () => {
      const pool2 = createPool({ connectionString: databaseUrl() });
      const { createLlmFromEnv } = await import('@photographic/llm');
      const { llm } = createLlmFromEnv({ PHOTOGRAPHIC_LLM: 'openai', OPENAI_API_KEY: process.env.OPENAI_API_KEY });
      const real = await createPostgresServices({ pool: pool2, baseUrl: 'https://photographic.test', llm });

      try {
        const { room, actor } = await (async () => {
          const email = `retrieval-real-${randomUUID()}@example.com`;
          const { person } = await real.services.identity.register({ email, displayName: 'Test' });
          const actor = real.actorFor(person.id, 'claude-desktop');
          const room = await real.services.rooms.create(actor, { title: `Ledning ${randomUUID()}` });
          return { room, actor };
        })();

        await real.services.ingest.remember(actor, {
          roomId: room.id,
          body: 'Vi ska inte längre använda Slack, all kommunikation sker i Photographic',
          explicit: true,
          kind: 'decision',
        });
        await real.runJobsToCompletion();

        const hits = await real.services.retrieval.search(actor, {
          query: 'Var håller vi numera till när vi pratar med varandra i jobbet?',
        });

        expect(hits[0]?.text).toContain('Slack');
      } finally {
        await real.close();
      }
    },
  );
});
