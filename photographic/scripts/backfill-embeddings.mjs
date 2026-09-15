#!/usr/bin/env node
/**
 * Embeds everything already saved, and says how far it got.
 *
 * `PgIngest` queues an embedding on write, so turning a real provider on improves search
 * for memories saved from that point and changes nothing about the ones a person already
 * has. This is what closes that gap — the difference between "search got better for what
 * I save from now on" and "my memory got better".
 *
 *   DATABASE_URL=… PHOTOGRAPHIC_LLM=openai OPENAI_API_KEY=… node scripts/backfill-embeddings.mjs
 *
 * Safe to interrupt and safe to re-run. There is no cursor: the work list is
 * "active memories with no vector, or a vector from a different model", recomputed every
 * batch, so stopping and starting loses nothing and cannot pay for the same memory
 * twice. See `packages/db/src/embedding-backfill.ts`.
 *
 * Flags:
 *   --status   print progress and exit without embedding anything
 *   --batch=N  rows per batch (default 50)
 *
 * Prints a JSON line per batch and a final line with what remains. It never claims to
 * have finished: the last line is the count, and zero is the only thing that means done.
 */

import { createPool, databaseUrl } from '../packages/db/src/pool.js';
import {
  embeddingBackfillProgress,
  runEmbeddingBackfillBatch,
} from '../packages/db/src/embedding-backfill.js';
import { createLlmFromEnv } from '../packages/llm/src/select.js';

const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const batchArg = args.find((a) => a.startsWith('--batch='));
const batchSize = batchArg ? Number(batchArg.split('=')[1]) : undefined;

const { kind, llm } = createLlmFromEnv();
const pool = createPool({ connectionString: databaseUrl() });

function say(entry) {
  console.log(JSON.stringify(entry));
}

try {
  const start = await embeddingBackfillProgress(pool, llm);
  say({ event: 'backfill_start', provider: kind, ...start });

  if (kind === 'fake' && !statusOnly) {
    // Refused rather than run. FakeLlm's vectors are deterministic hashes with no
    // semantic content, so backfilling with it would mark every memory as embedded and
    // make the real backfill look finished before it ran.
    say({
      event: 'backfill_refused',
      reason:
        'PHOTOGRAPHIC_LLM is not set to a real provider. Running with the deterministic fake would mark every memory as embedded by "fake" without making anything searchable by meaning.',
    });
    process.exit(1);
  }

  if (statusOnly) {
    process.exit(start.done ? 0 : 2);
  }

  let guard = 0;
  let remaining = start.remaining;

  while (remaining > 0) {
    const result = await runEmbeddingBackfillBatch(pool, llm, {
      ...(batchSize ? { batchSize } : {}),
    });
    say({ event: 'backfill_batch', ...result });

    // A batch that embeds nothing while claiming work remains is a bug — a body the
    // provider refuses, say — and looping on it forever is worse than stopping and
    // saying so.
    if (result.embedded === 0) {
      say({
        event: 'backfill_stalled',
        remaining: result.remaining,
        reason: 'a batch embedded nothing while work remained; inspect the rows above',
      });
      process.exit(3);
    }

    remaining = result.remaining;
    guard += 1;
    if (guard > 100_000) {
      say({ event: 'backfill_stalled', remaining, reason: 'batch guard tripped' });
      process.exit(3);
    }
  }

  say({ event: 'backfill_done', ...(await embeddingBackfillProgress(pool, llm)) });
} finally {
  await pool.end();
}
