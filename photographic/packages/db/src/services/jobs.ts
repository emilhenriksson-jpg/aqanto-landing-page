/**
 * Background work, backed by `app.job`.
 *
 * Postgres is the queue, as the schema comment insists: no Redis, no Kafka. `enqueue`
 * upserts on `dedupe_key` so ten saves in one conversation produce one profile rebuild,
 * the same guarantee `MemoryJobs` gives in memory. `runOnce` claims ready rows with
 * `FOR UPDATE SKIP LOCKED` so two processes sweeping the same queue do not double-run a
 * handler, then deletes what it ran -- there is no completed-jobs table to keep small.
 *
 * A claim is a *lease*. It used to be a `locked_at` timestamp with nothing behind it,
 * which meant a process dying between claiming a job and finishing it left that job
 * locked for good — and on one machine that restarts on every deploy, that is how
 * profiles, briefs, embeddings, invite expiry and document summaries stop updating
 * without anything saying so. Now a claim names the worker and expires, a handler
 * extends it while it is genuinely working, and every sweep first reclaims what a dead
 * worker was holding. A job that outlives its lease repeatedly runs out of attempts and
 * fails where `app.job_stats` can see it, rather than looping until someone notices.
 */

import { hostname } from 'node:os';

import type { JobPort } from '@photographic/core';
import type { Pool, PoolClient } from 'pg';

import type { Db } from '../pool.js';

export interface JobRequest {
  kind: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  runAfter?: Date;
}

/**
 * Enqueues on whichever unit of work the caller is already inside.
 *
 * A free function and not only a method, because a lifecycle transition wants the job row
 * to commit or roll back with the state change it follows from: an item that is now in the
 * trash and a `rebuild_projections` job that never got written is a stale brief nobody
 * asked for again.
 */
export async function enqueueJob(db: Db, input: JobRequest): Promise<void> {
  const dedupeKey = input.dedupeKey ?? null;
  const payload = JSON.stringify(input.payload ?? {});
  const runAfter = input.runAfter ?? new Date();

  if (dedupeKey) {
    // Mirrors the partial unique index: only one *unclaimed, unfailed* row per
    // dedupe key may exist, so replacing it is an update when one is there and an
    // insert when it is not.
    const updated = await db.query(
      `UPDATE app.job SET kind = $1, payload = $2, run_after = $3
       WHERE dedupe_key = $4 AND locked_at IS NULL AND failed_at IS NULL`,
      [input.kind, payload, runAfter, dedupeKey],
    );
    if (updated.rowCount && updated.rowCount > 0) return;
  }

  await db.query(
    `INSERT INTO app.job (kind, payload, dedupe_key, run_after) VALUES ($1, $2, $3, $4)`,
    [input.kind, payload, dedupeKey, runAfter],
  );
}

/**
 * How long a claim is believed.
 *
 * Two minutes: comfortably longer than any handler here takes (the slowest is a model
 * call for a document summary) and short enough that a deploy's worth of restarts does
 * not leave work parked for an hour. A handler that legitimately runs longer keeps its
 * claim by heartbeating, so this is not a timeout on the work — only on silence.
 */
export const DEFAULT_LEASE_SECONDS = 120;

/** How often a running handler extends its lease. A third of it, so one lost tick is survivable. */
const HEARTBEAT_DIVISOR = 3;

/** How many jobs one sweep takes. Bounded so a lease covers the batch, not the backlog. */
export const DEFAULT_CLAIM_BATCH = 10;

export interface JobStats {
  /** Unclaimed and unfailed, whether or not they are due yet. */
  pending: number;
  /** Unclaimed, unfailed and due now. This is the number that should not grow. */
  due: number;
  running: number;
  /** Claimed by a worker that has stopped saying anything. Should be zero. */
  expiredLeases: number;
  failed: number;
  /** When the oldest waiting job was due. Null when nothing is waiting. */
  oldestPendingAt: Date | null;
  /** Seconds the oldest waiting job has been waiting. Zero when nothing is waiting. */
  oldestPendingSeconds: number;
  worstAttempts: number;
}

/** A named worker, so a lapsed lease says who was holding it. */
export function workerId(): string {
  return `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
}

export class PgJobs implements JobPort {
  private readonly handlers = new Map<string, (payload: Record<string, unknown>) => Promise<void>>();
  readonly failures: Array<{ kind: string; error: unknown }> = [];
  private readonly worker: string;
  private readonly leaseSeconds: number;
  private readonly batchSize: number;

  constructor(
    private readonly pool: Pool,
    options: { worker?: string; leaseSeconds?: number; batchSize?: number } = {},
  ) {
    this.worker = options.worker ?? workerId();
    this.leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.batchSize = options.batchSize ?? DEFAULT_CLAIM_BATCH;
  }

  /** Which worker this process claims as. Recorded on every claim it holds. */
  get id(): string {
    return this.worker;
  }

  async enqueue(input: JobRequest): Promise<void> {
    await enqueueJob(this.pool, input);
  }

  /**
   * Schedules work that has to keep happening, rather than work someone asked for.
   *
   * The trash purge, invite expiry, storage reconciliation and document purge all had
   * handlers registered and nothing that ever enqueued them: the handler existed, so it
   * read as done, and invites simply never expired. Each recurring job re-enqueues itself
   * for its next run, and this seeds the first one — one row per kind, because the dedupe
   * key is the kind.
   *
   * Seeded one interval out, not immediately. A boot is the worst moment to start a purge,
   * and a test that drains the queue should not be made to carry out maintenance it did
   * not ask for.
   */
  async scheduleRecurring(
    definitions: Array<{ kind: string; everySeconds: number }>,
  ): Promise<void> {
    for (const definition of definitions) {
      await this.enqueue({
        kind: definition.kind,
        dedupeKey: recurringKey(definition.kind),
        runAfter: new Date(Date.now() + definition.everySeconds * 1000),
        payload: { recurring: definition.everySeconds },
      });
    }
  }

  work(kind: string, handler: (payload: Record<string, unknown>) => Promise<void>): void {
    this.handlers.set(kind, handler);
  }

  async runOnce(): Promise<number> {
    // Before claiming anything: take back what a dead worker was holding. Done first so a
    // restarted process picks up its own abandoned work on its next tick rather than
    // waiting for someone to notice.
    await this.reclaimExpired();

    const client = await this.pool.connect();
    let ran = 0;
    try {
      const due = await claimDue(client, this.worker, this.leaseSeconds, this.batchSize);
      for (const job of due) {
        const handler = this.handlers.get(job.kind);
        if (!handler) {
          // No handler registered: dropped rather than retried forever, exactly as
          // `MemoryJobs` does. A queue that silently grows is a worse symptom than one
          // that loses a job nobody was going to process anyway.
          await client.query('DELETE FROM app.job WHERE id = $1', [job.id]);
          continue;
        }

        // Kept alive while the handler works, so a slow job is not mistaken for a dead
        // one. `unref` so a heartbeat can never be the reason the process stays up.
        const heartbeat = setInterval(
          () => {
            void this.pool
              .query(
                `UPDATE app.job
                 SET heartbeat_at = now(), lease_expires_at = now() + ($2 || ' seconds')::interval
                 WHERE id = $1 AND locked_by = $3`,
                [job.id, this.leaseSeconds, this.worker],
              )
              .catch(() => undefined);
          },
          (this.leaseSeconds / HEARTBEAT_DIVISOR) * 1000,
        );
        heartbeat.unref();

        try {
          await handler(job.payload);
          await client.query('DELETE FROM app.job WHERE id = $1', [job.id]);
          ran += 1;
          // Recurrence lives here rather than in each handler, so a maintenance job
          // cannot be the one that forgot to schedule its next run. Enqueued after the
          // delete, because the dedupe key is the same row.
          const every = job.payload['recurring'];
          if (typeof every === 'number' && every > 0) {
            await this.enqueue({
              kind: job.kind,
              dedupeKey: recurringKey(job.kind),
              runAfter: new Date(Date.now() + every * 1000),
              payload: { recurring: every },
            });
          }
        } catch (error) {
          this.failures.push({ kind: job.kind, error });
          await client.query(
            `UPDATE app.job
             SET locked_at = NULL, locked_by = NULL, lease_expires_at = NULL,
                 heartbeat_at = NULL, attempts = attempts + 1,
                 last_error = $2,
                 failed_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE NULL END
             WHERE id = $1`,
            [job.id, error instanceof Error ? error.message : String(error)],
          );
        } finally {
          clearInterval(heartbeat);
        }
      }
    } finally {
      client.release();
    }
    return ran;
  }

  /**
   * Takes back claims whose lease has lapsed, and fails what has used up its attempts.
   *
   * Returns what it touched so a caller can log it: a reclaim is the visible trace of a
   * process that died, and it is the only place that fact is ever recorded.
   */
  async reclaimExpired(limit = 100): Promise<Array<{ id: number; kind: string; failed: boolean }>> {
    const { rows } = await this.pool.query<{
      id: string;
      kind: string;
      attempts: number;
      failed: boolean;
    }>(`SELECT id, kind, attempts, failed FROM app.reclaim_expired_jobs($1)`, [limit]);

    return rows.map((row) => ({ id: Number(row.id), kind: row.kind, failed: row.failed }));
  }

  /** Queue depth, oldest waiting job, stuck leases and failures. */
  async stats(): Promise<JobStats> {
    const { rows } = await this.pool.query<{
      pending: string;
      due: string;
      running: string;
      expired_leases: string;
      failed: string;
      oldest_pending_at: Date | null;
      worst_attempts: number | null;
    }>(`SELECT * FROM app.job_stats`);

    const row = rows[0];
    const oldestPendingAt = row?.oldest_pending_at ?? null;

    return {
      pending: Number(row?.pending ?? 0),
      due: Number(row?.due ?? 0),
      running: Number(row?.running ?? 0),
      expiredLeases: Number(row?.expired_leases ?? 0),
      failed: Number(row?.failed ?? 0),
      oldestPendingAt,
      oldestPendingSeconds: oldestPendingAt
        ? Math.max(0, Math.round((Date.now() - oldestPendingAt.getTime()) / 1000))
        : 0,
      worstAttempts: row?.worst_attempts ?? 0,
    };
  }

  /**
   * Failures grouped by kind, with no error text.
   *
   * What a screen can safely show: an error string can carry a fragment of whatever the
   * handler was working on, and one person's memory must not surface in another person's
   * response. The text stays in `listFailed`, which is for a log or an operator.
   */
  async failedKinds(): Promise<Array<{ kind: string; count: number; oldestFailedAt: Date }>> {
    const { rows } = await this.pool.query<{
      kind: string;
      count: string;
      oldest_failed_at: Date;
    }>(
      `SELECT kind, count(*) AS count, min(failed_at) AS oldest_failed_at FROM app.job
       WHERE failed_at IS NOT NULL
       GROUP BY kind ORDER BY count(*) DESC LIMIT 20`,
    );

    return rows.map((row) => ({
      kind: row.kind,
      count: Number(row.count),
      oldestFailedAt: row.oldest_failed_at,
    }));
  }

  /** Failed jobs, for whoever is answering "why did this stop updating". */
  async listFailed(limit = 20): Promise<
    Array<{ id: number; kind: string; attempts: number; failedAt: Date; lastError: string | null }>
  > {
    const { rows } = await this.pool.query<{
      id: string;
      kind: string;
      attempts: number;
      failed_at: Date;
      last_error: string | null;
    }>(
      `SELECT id, kind, attempts, failed_at, last_error FROM app.job
       WHERE failed_at IS NOT NULL ORDER BY failed_at DESC LIMIT $1`,
      [limit],
    );

    return rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      attempts: row.attempts,
      failedAt: row.failed_at,
      lastError: row.last_error,
    }));
  }

  async drain(maxPasses = 20): Promise<number> {
    let total = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const ran = await this.runOnce();
      total += ran;
      if (ran === 0) return total;
    }
    throw new Error('Jobbkön tog inte slut; ett jobb köar troligen sig själv.');
  }
}

/** The dedupe key a recurring job reuses, so there is one row per kind and not a pile. */
export function recurringKey(kind: string): string {
  return `recurring:${kind}`;
}

interface ClaimedJob {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

async function claimDue(
  client: PoolClient,
  worker: string,
  leaseSeconds: number,
  limit: number,
): Promise<ClaimedJob[]> {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<{ id: number; kind: string; payload: Record<string, unknown> }>(
      `UPDATE app.job
       SET locked_at = now(),
           locked_by = $1,
           lease_expires_at = now() + ($2 || ' seconds')::interval,
           heartbeat_at = now()
       WHERE id IN (
         SELECT id FROM app.job
         WHERE run_after <= now() AND locked_at IS NULL AND failed_at IS NULL
         ORDER BY id
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, kind, payload`,
      [worker, leaseSeconds, limit],
    );
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
