/**
 * How well Swedish search actually works, measured rather than quoted.
 *
 * `STATUS.md` has carried two numbers — 81% with no key, 100% with a real one — from a
 * measurement whose corpus and harness were deleted after use. That made them
 * unfalsifiable: no test in the repo could disagree with them, and they are what an
 * embedding decision was taken on. This file is the replacement, and it fails when the
 * numbers stop holding.
 *
 * Metric: recall@3 through the real shipped path — `createPostgresServices` +
 * `PgRetrieval`, against a live Postgres with `pg_trgm`, `unaccent` and `pgvector`. Not
 * a reimplementation of the ranking, and not a unit test of one arm: recall@3 is what a
 * person experiences, because three results is what they read.
 *
 * Two runs, because they answer different questions:
 *
 *  - **No key.** `FakeLlm`, the default. Its embeddings are deterministic hashes, so the
 *    vector arm contributes nothing semantic and the score is the stemmed-FTS and
 *    trigram arms alone. This is what a laptop and an unconfigured process get.
 *  - **Real key.** `OpenAiLlm` with `OPENAI_API_KEY`, embeddings written by the same
 *    deferred `embed_item` job production uses. Skipped rather than failed without a
 *    key, because the suite has to run offline.
 *
 * The thresholds below are floors a few points under the measured values, so ordinary
 * variation does not turn this into a flaky test, while a real regression — someone
 * "simplifying" the OR'd tsquery back to `plainto_tsquery`, or the trigram floor being
 * lowered again — still trips it. The measured values are recorded next to each floor.
 */

import { randomUUID } from 'node:crypto';

import type { Actor, LlmPort, RoomId, ShortId } from '@photographic/core';
import { OpenAiLlm } from '@photographic/llm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, databaseUrl } from './pool.js';
import { createPostgresServices, type PostgresServices } from './postgres-services.js';
import {
  CORPUS_MEMORIES,
  CORPUS_QUESTIONS,
  type QuestionCategory,
} from './search-quality.corpus.js';

const TOP_N = 3;

let pool: Pool | null = null;

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
});

afterAll(async () => {
  await pool?.end();
});

interface Loaded {
  wired: PostgresServices;
  actor: Actor;
  /** Corpus key to the short id it was saved under this run. */
  keyToShortId: Map<string, ShortId>;
}

/**
 * Loads the corpus through the real write path, then drains the job queue so the
 * embedding backfill job that `PgIngest` queues has actually run.
 *
 * `explicit: true` on the shared-room writes because every write into a room other
 * people can read goes through the approval gate otherwise — this test is about ranking,
 * not about the gate, and the gate has its own tests.
 */
async function loadCorpus(llm: LlmPort): Promise<Loaded> {
  const wired = await createPostgresServices({
    pool: pool!,
    baseUrl: 'https://photographic.test',
    llm,
    log: () => {},
  });

  const email = `search-quality-${randomUUID()}@example.com`;
  const { person, personalRoom } = await wired.services.identity.register({
    email,
    displayName: 'Emil',
  });
  const actor = wired.actorFor(person.id, 'claude-desktop');
  const ledning = await wired.services.rooms.create(actor, { title: 'Buyersclub Ledning' });

  const rooms: Record<'personal' | 'ledning', RoomId> = {
    personal: personalRoom.id,
    ledning: ledning.id,
  };

  const keyToShortId = new Map<string, ShortId>();

  for (const memory of CORPUS_MEMORIES) {
    const decision = await wired.services.ingest.remember(actor, {
      roomId: rooms[memory.room],
      body: memory.body,
      kind: 'fact',
      explicit: true,
    });

    if (decision.outcome === 'auto') {
      keyToShortId.set(memory.key, decision.item.shortId);
      continue;
    }
    if (decision.outcome === 'needs_approval') {
      const item = await wired.services.ingest.resolveProposal(
        actor,
        decision.proposal.id,
        true,
      );
      keyToShortId.set(memory.key, item!.shortId);
      continue;
    }
    throw new Error(`corpus memory "${memory.key}" was treated as a duplicate`);
  }

  // The vector arm reads `item.embedding`, which a deferred job writes. Without this the
  // "real key" run would measure the lexical arms and report them as the embedding score.
  await wired.runJobsToCompletion();

  return { wired, actor, keyToShortId };
}

interface Score {
  hits: number;
  total: number;
  percent: number;
  byCategory: Map<QuestionCategory, { hits: number; total: number }>;
  misses: string[];
}

async function measure(loaded: Loaded): Promise<Score> {
  const byCategory = new Map<QuestionCategory, { hits: number; total: number }>();
  const misses: string[] = [];
  let hits = 0;

  for (const question of CORPUS_QUESTIONS) {
    const expected = loaded.keyToShortId.get(question.expects);
    if (!expected) throw new Error(`question points at unknown memory "${question.expects}"`);

    const results = await loaded.wired.services.retrieval.search(loaded.actor, {
      query: question.query,
      limit: TOP_N,
    });

    const found = results.slice(0, TOP_N).some((hit) => hit.shortId === expected);
    if (found) hits += 1;
    else misses.push(`[${question.category}] ${question.query}`);

    const bucket = byCategory.get(question.category) ?? { hits: 0, total: 0 };
    bucket.total += 1;
    if (found) bucket.hits += 1;
    byCategory.set(question.category, bucket);
  }

  return {
    hits,
    total: CORPUS_QUESTIONS.length,
    percent: Math.round((hits / CORPUS_QUESTIONS.length) * 100),
    byCategory,
    misses,
  };
}

function report(label: string, score: Score): void {
  const categories = [...score.byCategory]
    .map(([category, { hits, total }]) => `${category} ${hits}/${total}`)
    .join(', ');

  // Printed, because the aggregate is the least interesting part: the per-category split
  // is what the decision actually turned on.
  console.log(
    `[search quality · ${label}] recall@${TOP_N} ${score.hits}/${score.total} (${score.percent}%) — ${categories}`,
  );
  if (score.misses.length > 0) console.log(`  misses: ${score.misses.join(' | ')}`);
}

/**
 * A client for `OpenAiLlm` built from `fetch` rather than from the `openai` SDK.
 *
 * Two reasons, and neither is avoiding a dependency for its own sake. It keeps this
 * package's dependency graph as it is — `openai` is the composition root's business, not
 * the database's. And it exercises `OpenAiClientLike`, which is the seam a second
 * provider is swapped in through, so this measurement runs against the same shape a
 * different vendor would be wired in as.
 *
 * Only `embeddings` is real. The chat side is not used by a search measurement, and a
 * stub that throws is better than one that silently returns nothing.
 */
function httpEmbeddingClient(apiKey: string) {
  return {
    embeddings: {
      async create(body: { model: string; input: string[]; dimensions?: number }) {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new Error(`openai embeddings ${response.status}: ${await response.text()}`);
        }
        return (await response.json()) as { data: Array<{ index: number; embedding: number[] }> };
      },
    },
    chat: {
      completions: {
        create(): never {
          throw new Error('the search-quality measurement does not use chat completions');
        },
      },
    },
  } as never;
}

describe('Swedish search quality with no model configured', () => {
  it('reaches the floor the stemmed-FTS and trigram arms alone are worth', async (ctx) => {
    if (!pool) return ctx.skip();

    const loaded = await loadCorpus(new (await import('@photographic/core/testing')).FakeLlm());
    const score = await measure(loaded);
    report('FakeLlm', score);

    /**
     * Measured 24/27 = 89% on this corpus (near-exact 10/10, inflection 7/7, synonym
     * 4/4, compound 1/1, hard-paraphrase 2/5).
     *
     * Higher than the 81% `STATUS.md` has been quoting, and the difference is the corpus
     * rather than the code: the original 25 memories and 27 questions were deleted after
     * that measurement, so this is a reconstruction of the same shape and cannot
     * reproduce its exact score. The floor is 80%, a few points under what was measured.
     * Below that, something load-bearing in the lexical arms has changed — most likely
     * the OR'd tsquery being "simplified" back to `plainto_tsquery`, which the original
     * measurement put at 19%.
     */
    expect(score.percent).toBeGreaterThanOrEqual(80);

    /**
     * The category the embedding decision actually turned on, asserted as a ceiling
     * rather than left in prose: without a real model, most questions that share no
     * content word with their answer are not found. Measured 2/5 here — not the 0/5 the
     * original reported for pure lexical strategies, because two of these five happen to
     * share an inflected anchor the trigram arm can reach. The ceiling is 3: if the
     * lexical arms alone ever score 4 or 5, this corpus has gone soft and the paraphrase
     * questions need to be harder, because a corpus that lexical ranking can answer
     * cannot be used to argue for embeddings.
     */
    const paraphrase = score.byCategory.get('hard-paraphrase')!;
    expect(paraphrase.hits).toBeLessThanOrEqual(3);
  }, 120_000);
});

describe('Swedish search quality with a real embedding model', () => {
  it('finds a genuine paraphrase, which is what the lexical arms cannot do', async (ctx) => {
    if (!pool) return ctx.skip();
    const apiKey = process.env.OPENAI_API_KEY;
    // Skipped, not failed: the suite must run offline and free.
    if (!apiKey) return ctx.skip();

    const loaded = await loadCorpus(new OpenAiLlm({ client: httpEmbeddingClient(apiKey) }));
    const score = await measure(loaded);
    report('OpenAiLlm', score);

    /**
     * Measured 27/27 = 100% with `text-embedding-3-small`, every category complete —
     * which is exactly the figure `STATUS.md` quotes, reproduced here against a real key
     * on a corpus this code has never been tuned against. The floor is 90%: high enough
     * that losing the vector arm (which would drop this to the lexical score) fails, low
     * enough to survive one ranking wobble.
     */
    expect(score.percent).toBeGreaterThanOrEqual(90);

    /**
     * The categorical claim, and the whole reason embeddings were turned on: 5/5 on the
     * paraphrase questions against 2/5 without a model. This is the assertion that would
     * fail if the vector arm were quietly broken — the aggregate would barely move,
     * because the other 22 questions are answerable lexically.
     */
    const paraphrase = score.byCategory.get('hard-paraphrase')!;
    expect(paraphrase.hits).toBeGreaterThanOrEqual(4);
  }, 300_000);
});
