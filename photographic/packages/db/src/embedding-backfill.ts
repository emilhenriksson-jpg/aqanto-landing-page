/**
 * Making the embedding model apply to everything already saved, not only to what comes
 * next.
 *
 * `PgIngest` queues an embedding on write, so switching a real provider on improves
 * search for future memories and changes nothing about the ones a person already has.
 * That is the difference between "search got better for things I save from now on" and
 * "my memory got better", and only the second one is what was promised.
 *
 * ## Resumable without a cursor
 *
 * There is deliberately no bookmark, no offset and no "last processed id". The work list
 * is derived from the data every time it runs:
 *
 *   status = 'active' AND (embedding IS NULL OR embedding_model IS DISTINCT FROM <model>)
 *
 * So a restart mid-run resumes exactly where it stopped, because "where it stopped" is
 * just "what is still unembedded". A cursor would have to be persisted, kept consistent
 * with rows written while the run was in flight, and reset by hand whenever the model
 * changed — three ways to lose work, in exchange for nothing.
 *
 * ## Cannot double-charge
 *
 * Two independent reasons, since an API call costs money and a restart is the normal
 * case rather than the exceptional one:
 *
 *  1. A row leaves the work list the moment its vector and `embedding_model` are
 *     written, in one statement. Re-running the query after a crash cannot return it.
 *  2. Only one backfill job can be pending at a time. `PgJobs.enqueue` mirrors the
 *     partial unique index on `dedupe_key`, so the self-rescheduling below collapses
 *     into a single queued job however many times it is asked for, and `PgJobs.runOnce`
 *     claims with `FOR UPDATE SKIP LOCKED` so two workers cannot claim the same one.
 *
 * The one case that does spend an API call twice is a process killed after the provider
 * answered and before the `UPDATE` committed — at most one batch, and unavoidable
 * without a two-phase commit against someone else's API.
 *
 * ## Visible enough to know it finished
 *
 * `embeddingBackfillProgress` counts the remaining set directly, so "is it done" is a
 * question about the data rather than about whether a log line was seen. The job logs
 * one line per batch with the count left, and `scripts/backfill-embeddings.mjs` prints
 * progress until it reaches zero. Nothing here concludes that it finished; it either
 * shows zero remaining or it does not.
 */

import type { LlmPort } from '@photographic/core';
import type { Pool } from 'pg';

import { toVectorLiteral } from './vector.js';

/**
 * Rows per run.
 *
 * Small on purpose. `MAX_EMBED_BATCH` in `@photographic/llm` is 128 and this is well
 * under it, because the cost of a batch that fails or is interrupted is the whole batch:
 * a smaller one loses less and lets the job queue interleave everything else the process
 * has to do.
 */
export const EMBEDDING_BACKFILL_BATCH = 50;

export const EMBEDDING_BACKFILL_JOB = 'backfill_embeddings';

/** One queued backfill at a time, however many callers ask for one. */
export const EMBEDDING_BACKFILL_DEDUPE_KEY = 'backfill_embeddings:all';

export interface EmbeddingBackfillProgress {
  /** Active memories that could hold a vector. */
  total: number;
  /** Active memories whose vector was produced by the currently configured model. */
  embedded: number;
  /** Never embedded, or embedded by a different model. */
  remaining: number;
  /** How many carry a vector from some *other* model — the fake, or an older one. */
  stale: number;
  done: boolean;
  /** What `remaining` is measured against. Null when the provider does not say. */
  model: string | null;
}

/**
 * What is left to do, counted rather than assumed.
 *
 * Takes the model from the port so that the answer is always relative to what this
 * process would actually write. Asking "how many are embedded" without saying by what is
 * how a backfill gets reported as complete after the model changed underneath it.
 */
export async function embeddingBackfillProgress(
  pool: Pool,
  llm: Pick<LlmPort, 'embeddingIdentity'>,
): Promise<EmbeddingBackfillProgress> {
  const identity = llm.embeddingIdentity?.() ?? null;
  const model = identity?.model ?? null;

  const { rows } = await pool.query<{ total: string; embedded: string; stale: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (
              WHERE embedding IS NOT NULL AND embedding_model IS NOT DISTINCT FROM $1
            ) AS embedded,
            count(*) FILTER (
              WHERE embedding IS NOT NULL AND embedding_model IS DISTINCT FROM $1
            ) AS stale
     FROM app.item
     WHERE status = 'active'`,
    [model],
  );

  const total = Number(rows[0]!.total);
  const embedded = Number(rows[0]!.embedded);

  return {
    total,
    embedded,
    remaining: total - embedded,
    stale: Number(rows[0]!.stale),
    done: total === embedded,
    model,
  };
}

export interface BackfillBatchResult {
  /** Memories embedded by this run. */
  embedded: number;
  /** Still to do after it. */
  remaining: number;
}

/**
 * Embeds one batch and records which model saw the text.
 *
 * The vector and its provenance are written in the same statement, so there is no state
 * in which a memory has a vector and no record of where it came from — which is the
 * whole point of recording it: "your text was sent to a model" has to be answerable for
 * every memory that is true of, including the ones backfilled long after they were
 * saved.
 *
 * Per row rather than one big `UPDATE ... FROM`: a provider that returns a short or
 * reordered batch must not be able to attach one memory's vector to another, and
 * `embed` guarantees order but this does not have to trust that to be safe.
 */
export async function runEmbeddingBackfillBatch(
  pool: Pool,
  llm: Pick<LlmPort, 'embed' | 'embeddingIdentity'>,
  options: { batchSize?: number } = {},
): Promise<BackfillBatchResult> {
  const identity = llm.embeddingIdentity?.() ?? null;
  const model = identity?.model ?? null;
  const batchSize = options.batchSize ?? EMBEDDING_BACKFILL_BATCH;

  const { rows } = await pool.query<{ id: string; body: string }>(
    `SELECT id, body
     FROM app.item
     WHERE status = 'active'
       AND body <> ''
       AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $1)
     -- Oldest first, so a long backfill makes the person's earliest memories searchable
     -- first. They are the ones least likely to be re-saved by ordinary use.
     ORDER BY created_at ASC
     LIMIT $2`,
    [model, batchSize],
  );

  if (rows.length === 0) {
    const progress = await embeddingBackfillProgress(pool, llm);
    return { embedded: 0, remaining: progress.remaining };
  }

  const vectors = await llm.embed(rows.map((row) => row.body));

  let embedded = 0;
  for (const [index, row] of rows.entries()) {
    const vector = vectors[index];
    if (!vector) continue;

    await pool.query(
      `UPDATE app.item
       SET embedding = $1::vector,
           embedding_model = $2,
           embedding_provider = $3,
           embedded_at = now()
       WHERE id = $4`,
      [toVectorLiteral(vector), model, identity?.provider ?? null, row.id],
    );
    embedded += 1;
  }

  const progress = await embeddingBackfillProgress(pool, llm);
  return { embedded, remaining: progress.remaining };
}
