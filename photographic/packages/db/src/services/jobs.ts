/**
 * Background work, backed by `app.job`.
 *
 * Postgres is the queue, as the schema comment insists: no Redis, no Kafka. `enqueue`
 * upserts on `dedupe_key` so ten saves in one conversation produce one profile rebuild,
 * the same guarantee `MemoryJobs` gives in memory. `runOnce` claims ready rows with
 * `FOR UPDATE SKIP LOCKED` so two processes sweeping the same queue do not double-run a
 * handler, then deletes what it ran -- there is no completed-jobs table to keep small.
 */

import type { JobPort } from '@photographic/core';
import type { Pool, PoolClient } from 'pg';

export class PgJobs implements JobPort {
  private readonly handlers = new Map<string, (payload: Record<string, unknown>) => Promise<void>>();
  readonly failures: Array<{ kind: string; error: unknown }> = [];

  constructor(private readonly pool: Pool) {}

  async enqueue(input: {
    kind: string;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    runAfter?: Date;
  }): Promise<void> {
    const dedupeKey = input.dedupeKey ?? null;
    const payload = JSON.stringify(input.payload ?? {});
    const runAfter = input.runAfter ?? new Date();

    if (dedupeKey) {
      // Mirrors the partial unique index: only one *unclaimed, unfailed* row per
      // dedupe key may exist, so replacing it is an update when one is there and an
      // insert when it is not.
      const updated = await this.pool.query(
        `UPDATE app.job SET kind = $1, payload = $2, run_after = $3
         WHERE dedupe_key = $4 AND locked_at IS NULL AND failed_at IS NULL`,
        [input.kind, payload, runAfter, dedupeKey],
      );
      if (updated.rowCount && updated.rowCount > 0) return;
    }

    await this.pool.query(
      `INSERT INTO app.job (kind, payload, dedupe_key, run_after) VALUES ($1, $2, $3, $4)`,
      [input.kind, payload, dedupeKey, runAfter],
    );
  }

  work(kind: string, handler: (payload: Record<string, unknown>) => Promise<void>): void {
    this.handlers.set(kind, handler);
  }

  async runOnce(): Promise<number> {
    const client = await this.pool.connect();
    let ran = 0;
    try {
      const due = await claimDue(client);
      for (const job of due) {
        const handler = this.handlers.get(job.kind);
        if (!handler) {
          // No handler registered: dropped rather than retried forever, exactly as
          // `MemoryJobs` does. A queue that silently grows is a worse symptom than one
          // that loses a job nobody was going to process anyway.
          await client.query('DELETE FROM app.job WHERE id = $1', [job.id]);
          continue;
        }
        try {
          await handler(job.payload);
          await client.query('DELETE FROM app.job WHERE id = $1', [job.id]);
          ran += 1;
        } catch (error) {
          this.failures.push({ kind: job.kind, error });
          await client.query(
            `UPDATE app.job
             SET locked_at = NULL, locked_by = NULL, attempts = attempts + 1,
                 last_error = $2,
                 failed_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE NULL END
             WHERE id = $1`,
            [job.id, error instanceof Error ? error.message : String(error)],
          );
        }
      }
    } finally {
      client.release();
    }
    return ran;
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

interface ClaimedJob {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

async function claimDue(client: PoolClient): Promise<ClaimedJob[]> {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<{ id: number; kind: string; payload: Record<string, unknown> }>(
      `UPDATE app.job SET locked_at = now(), locked_by = 'inline'
       WHERE id IN (
         SELECT id FROM app.job
         WHERE run_after <= now() AND locked_at IS NULL AND failed_at IS NULL
         ORDER BY id
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, kind, payload`,
    );
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
