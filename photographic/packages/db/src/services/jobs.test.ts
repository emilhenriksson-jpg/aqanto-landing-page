/**
 * The queue's durability, which is the only part of it Postgres can answer for.
 *
 * The failure being tested is ordinary and was permanent: a process claims a job, the
 * machine restarts — a deploy, an OOM, a Fly host move — and the row stays claimed for
 * ever. Nothing errors. Profiles, briefs, embeddings, invite expiry and document summaries
 * simply stop changing, which reads as the product being a little stale rather than as an
 * incident, and nobody finds out until a person notices their memory has stopped keeping
 * up with them.
 *
 * So a dead worker is simulated the honest way: claim a job with one `PgJobs`, never
 * finish it, and let another one sweep. No mocking of time — the lease is set short and
 * the clock is the database's.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool } from '../pool.js';
import { PgJobs, recurringKey } from './jobs.js';

const pool = createPool();

/** Distinct per run, so this suite never claims another suite's rows. See AGENTS.md. */
const kind = `test_job_${Math.random().toString(36).slice(2, 8)}`;

beforeEach(async () => {
  await pool.query('DELETE FROM app.job WHERE kind LIKE $1', ['test_job_%']);
});

afterAll(async () => {
  await pool.query('DELETE FROM app.job WHERE kind LIKE $1', ['test_job_%']);
  await pool.end();
});

const rowOf = async (id?: number) =>
  (
    await pool.query<{
      id: string;
      locked_at: Date | null;
      locked_by: string | null;
      lease_expires_at: Date | null;
      heartbeat_at: Date | null;
      attempts: number;
      failed_at: Date | null;
      last_error: string | null;
    }>(
      id === undefined
        ? `SELECT * FROM app.job WHERE kind = $1 ORDER BY id LIMIT 1`
        : `SELECT * FROM app.job WHERE id = $2`,
      id === undefined ? [kind] : [kind, id],
    )
  ).rows[0];

describe('a claim is a lease', () => {
  it('records which worker holds it and until when', async () => {
    const jobs = new PgJobs(pool, { worker: 'test-worker-1', leaseSeconds: 60 });
    await jobs.enqueue({ kind });

    // A handler that never returns, so the claim is held while this is inspected.
    // The handler is held open through a deferred rather than by assigning inside the
    // executor, which reads as never-assigned to the type checker.
    const held: { release: () => void } = { release: () => {} };
    jobs.work(
      kind,
      () =>
        new Promise<void>((resolve) => {
          held.release = resolve;
        }),
    );
    const running = jobs.runOnce();

    // Wait for the claim rather than for a duration: the row is the thing being asserted.
    let row = await rowOf();
    for (let i = 0; i < 100 && !row?.locked_at; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      row = await rowOf();
    }

    expect(row?.locked_by).toBe('test-worker-1');
    expect(row?.lease_expires_at).not.toBeNull();
    expect(row!.lease_expires_at!.getTime()).toBeGreaterThan(Date.now());
    expect(row?.heartbeat_at).not.toBeNull();

    held.release();
    await running;
    expect(await rowOf()).toBeUndefined();
  });

  it('is taken back when the worker that held it is gone', async () => {
    // The Fly restart, as a test. The first worker claims and never comes back; nothing in
    // the database distinguishes that from a slow handler except the lease running out.
    const dead = new PgJobs(pool, { worker: 'dead-worker', leaseSeconds: 60 });
    await dead.enqueue({ kind });
    await pool.query(
      `UPDATE app.job SET locked_at = now(), locked_by = 'dead-worker',
                          lease_expires_at = now() - interval '1 minute'
       WHERE kind = $1`,
      [kind],
    );

    const alive = new PgJobs(pool, { worker: 'live-worker' });
    let ran = 0;
    alive.work(kind, async () => {
      ran += 1;
    });

    expect(await alive.runOnce()).toBe(1);
    expect(ran).toBe(1);
  });

  it('counts the reclaim, so a job that keeps killing its worker gives up visibly', async () => {
    // Without counting the attempt, a job that crashes the process every time is retried
    // until the end of the world at whatever it cost to die.
    const jobs = new PgJobs(pool, { worker: 'w' });
    await jobs.enqueue({ kind });
    await pool.query(
      `UPDATE app.job SET locked_at = now(), locked_by = 'gone',
                          lease_expires_at = now() - interval '1 minute',
                          attempts = max_attempts - 1
       WHERE kind = $1`,
      [kind],
    );

    const reclaimed = await jobs.reclaimExpired();
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.failed).toBe(true);

    const row = await rowOf();
    expect(row?.failed_at).not.toBeNull();
    expect(row?.last_error).toMatch(/försvann/);
  });

  it('does not touch a claim whose lease is still good', async () => {
    const jobs = new PgJobs(pool, { worker: 'w' });
    await jobs.enqueue({ kind });
    await pool.query(
      `UPDATE app.job SET locked_at = now(), locked_by = 'busy',
                          lease_expires_at = now() + interval '5 minutes'
       WHERE kind = $1`,
      [kind],
    );

    expect(await jobs.reclaimExpired()).toEqual([]);
    expect((await rowOf())?.locked_by).toBe('busy');
  });

  it('extends the lease while a handler is genuinely working', async () => {
    // The difference between "this job takes eleven minutes" and "this job's process is
    // gone", which a lease on its own cannot express.
    const leaseSeconds = 0.3;
    const jobs = new PgJobs(pool, { worker: 'slow-worker', leaseSeconds });
    await jobs.enqueue({ kind });

    const samples: Array<Date | null> = [];
    jobs.work(kind, async () => {
      // Three times the nominal lease. Without the heartbeat this claim would be expired
      // and reclaimable well before the handler returns.
      for (let i = 0; i < 3; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, leaseSeconds * 1000));
        samples.push((await rowOf())?.lease_expires_at ?? null);
      }
      // And a second worker sweeping mid-handler must not take it.
      expect(await new PgJobs(pool, { worker: 'other' }).reclaimExpired()).toEqual([]);
    });

    await jobs.runOnce();

    expect(samples).toHaveLength(3);
    expect(samples.every((at) => at !== null)).toBe(true);
    // Moving forward is the assertion: a fixed deadline would have passed by now.
    expect(samples[2]!.getTime()).toBeGreaterThan(samples[0]!.getTime());
    // And it finished rather than being reclaimed out from under itself.
    expect(await rowOf()).toBeUndefined();
  });
});

describe('what the queue says about itself', () => {
  it('reports depth, the oldest waiting job and failures', async () => {
    const jobs = new PgJobs(pool, { worker: 'w' });
    await jobs.enqueue({ kind, dedupeKey: `${kind}:a` });
    await jobs.enqueue({ kind, dedupeKey: `${kind}:b` });
    await pool.query(
      `UPDATE app.job SET run_after = now() - interval '9 minutes' WHERE dedupe_key = $1`,
      [`${kind}:a`],
    );

    const stats = await jobs.stats();
    expect(stats.pending).toBeGreaterThanOrEqual(2);
    expect(stats.due).toBeGreaterThanOrEqual(2);
    // The number that matters: depth alone cannot tell a busy queue from a stalled one.
    expect(stats.oldestPendingSeconds).toBeGreaterThanOrEqual(500);
  });

  it('groups failures by kind without exposing the error text', async () => {
    // An error string can carry a fragment of whatever the handler was working on, and one
    // person's memory must not turn up in another person's response.
    const jobs = new PgJobs(pool, { worker: 'w' });
    await jobs.enqueue({ kind });
    await pool.query(
      `UPDATE app.job SET failed_at = now(), last_error = 'Emils privata anteckning' WHERE kind = $1`,
      [kind],
    );

    const failed = await jobs.failedKinds();
    const mine = failed.find((entry) => entry.kind === kind);
    expect(mine?.count).toBe(1);
    expect(JSON.stringify(failed)).not.toContain('privata');

    // The text is still available where it belongs: to an operator, not to a screen.
    const detail = await jobs.listFailed();
    expect(detail.find((entry) => entry.kind === kind)?.lastError).toContain('privata');
  });

  it('counts a lapsed lease as its own number, because zero is the only acceptable value', async () => {
    const jobs = new PgJobs(pool, { worker: 'w' });
    await jobs.enqueue({ kind });
    await pool.query(
      `UPDATE app.job SET locked_at = now(), locked_by = 'gone',
                          lease_expires_at = now() - interval '1 hour'
       WHERE kind = $1`,
      [kind],
    );

    expect((await jobs.stats()).expiredLeases).toBeGreaterThanOrEqual(1);
  });
});

describe('recurring work', () => {
  it('is scheduled rather than left to a handler nobody enqueues', async () => {
    // `purge_trash` and `expire_invites` both had handlers and nothing that ever enqueued
    // them, so invites never expired and the feature read as built.
    const jobs = new PgJobs(pool, { worker: 'w' });
    await jobs.scheduleRecurring([{ kind, everySeconds: 900 }]);

    const row = await pool.query<{ dedupe_key: string; run_after: Date }>(
      `SELECT dedupe_key, run_after FROM app.job WHERE kind = $1`,
      [kind],
    );
    expect(row.rows[0]?.dedupe_key).toBe(recurringKey(kind));
    // One interval out, not now: a boot is the worst moment to start a purge.
    expect(row.rows[0]!.run_after.getTime()).toBeGreaterThan(Date.now());
  });

  it('schedules its next run after each one, so the chain survives a restart', async () => {
    const jobs = new PgJobs(pool, { worker: 'w' });
    await jobs.enqueue({
      kind,
      dedupeKey: recurringKey(kind),
      payload: { recurring: 900 },
    });

    let ran = 0;
    jobs.work(kind, async () => {
      ran += 1;
    });

    expect(await jobs.runOnce()).toBe(1);
    expect(ran).toBe(1);

    const next = await pool.query<{ run_after: Date; payload: { recurring?: number } }>(
      `SELECT run_after, payload FROM app.job WHERE kind = $1`,
      [kind],
    );
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0]?.payload.recurring).toBe(900);
    expect(next.rows[0]!.run_after.getTime()).toBeGreaterThan(Date.now());

    // And it does not run again in the same sweep, which would be a queue that never ends.
    expect(await jobs.runOnce()).toBe(0);
  });
});
