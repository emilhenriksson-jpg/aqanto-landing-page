/**
 * Whether the background work is keeping up.
 *
 * Everything a person sees that is not a memory they just wrote is built by a job:
 * profiles, briefs, room headlines, embeddings, document summaries, invite expiry. When
 * the queue stalls, none of that fails — it simply stops changing, which reads as "the
 * product is a bit stale" rather than as an incident, and that is how a memory quietly
 * stops keeping up with the person.
 *
 * So the numbers are exposed rather than inferred. Four of them answer the question:
 * how much is waiting, how long the oldest thing has waited, how many claims belong to a
 * worker that is gone, and how many jobs have given up.
 *
 * Counts and kinds only. Never an error string: those can carry fragments of whatever the
 * handler was working on, and this is not the place where one person's memory turns up in
 * another person's response. Failure detail goes to the structured log.
 */

import { Hono } from 'hono';

import type { AppContext, AppEnv } from '../context.js';

export interface QueueStatus {
  pending: number;
  due: number;
  running: number;
  expiredLeases: number;
  failed: number;
  oldestPendingSeconds: number;
  worstAttempts: number;
}

export interface ExportQueueStatus {
  pending: number;
  running: number;
  expiredLeases: number;
  failed: number;
  ready: number;
  oldestPendingSeconds: number;
}

/** The slice of `PgJobs` and `PgExports` this route reads. */
export interface QueueSource {
  jobStats(): Promise<QueueStatus>;
  failedKinds(): Promise<Array<{ kind: string; count: number; oldestFailedAt: Date }>>;
  exportStats(): Promise<ExportQueueStatus>;
}

export interface OpsRouteDeps {
  queue?: QueueSource | null;
}

export function opsRoutes(deps: OpsRouteDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/ops/queue', async (c) => {
    if (!deps.queue) return unavailable(c);

    const [jobs, failedKinds, exports] = await Promise.all([
      deps.queue.jobStats(),
      deps.queue.failedKinds(),
      deps.queue.exportStats(),
    ]);

    // `healthy` is stated here rather than left to a reader to work out, because the
    // thresholds are a judgement about this product: a job waiting five minutes means
    // nothing is sweeping, and a lapsed lease means a worker died holding work.
    const healthy =
      jobs.expiredLeases === 0 &&
      jobs.failed === 0 &&
      exports.expiredLeases === 0 &&
      jobs.oldestPendingSeconds < STALE_AFTER_SECONDS;

    return c.json({
      queue: {
        healthy,
        jobs,
        exports,
        failedKinds: failedKinds.map((entry) => ({
          kind: entry.kind,
          count: entry.count,
          oldestFailedAt: entry.oldestFailedAt.toISOString(),
        })),
        staleAfterSeconds: STALE_AFTER_SECONDS,
      },
    });
  });

  return routes;
}

/**
 * When a waiting job stops being normal.
 *
 * The sweep runs every second, so anything that has waited five minutes is not waiting
 * for its turn — it is waiting for a process that is not there.
 */
export const STALE_AFTER_SECONDS = 300;

function unavailable(c: AppContext) {
  return c.json(
    {
      error: {
        code: 'unavailable',
        message: 'Köstatus kräver en databas. Sätt DATABASE_URL.',
      },
    },
    503,
  );
}
