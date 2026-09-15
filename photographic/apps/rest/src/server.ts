/**
 * The process.
 *
 * Reads the environment, builds the wiring, starts listening, and stops cleanly. Every
 * decision about what is wired to what lives in `wiring.ts`, so that the part a test can
 * cover is not tangled with the part that cannot be.
 *
 * `DATABASE_URL` selects `@photographic/db`'s Postgres services; unset, it is the
 * in-memory reference implementation and data does not survive a restart. Both are
 * production paths now, not a placeholder and a promise.
 */

import { serve } from '@hono/node-server';
import { startAlerting } from '@photographic/ops';

import { loadConfigFromEnv } from './config.js';
import { createLogger } from './logger.js';
import { createWiring } from './wiring.js';

const config = loadConfigFromEnv();
const logger = createLogger({
  level: config.logLevel,
  // On a laptop the log is the delivery channel and the code has to be readable there.
  // In production it must not be readable at all, by anyone who can read logs — which is
  // the whole reason this deploy had a way in that a read-only token could use.
  revealSignupCode: config.environment !== 'production',
});

if (process.env.DATABASE_URL) {
  logger.info('using_postgres', { detail: 'DATABASE_URL är satt: kör mot Postgres.' });
} else {
  logger.warn('using_reference_implementation', {
    detail: 'Inget DATABASE_URL: kör mot minnesimplementationen. Data försvinner vid omstart.',
  });
}

const wiring = await createWiring({ config, logger });

/**
 * The alarms, above the timers rather than inside them.
 *
 * Every failure this project has had so far was found by a person noticing that something
 * looked wrong: the log line existed, and nobody was reading it. So this is deliberately
 * not another log line — it sends to a webhook and an SMS when configured, and pings an
 * external dead-man's switch on every healthy pass so that the one failure this process
 * cannot report, its own absence, still reaches someone.
 *
 * Started here for the same reason the timers are here: `createWiring` has no side effects
 * on purpose, and a watchdog is nothing but a side effect.
 */
const alerting = startAlerting({
  env: process.env,
  logger,
  facts: {
    environment: config.environment,
    persistence: wiring.operations.persistence,
    storageKind: wiring.operations.storageKind,
  },
  db: wiring.operations.db,
  deliveryFailures: wiring.operations.deliveryFailures,
});

// Background work runs on a timer rather than a separate worker process, which is right
// for development and is the first thing to split out when there is more than one
// instance: two processes sweeping the same queue would each rebuild every projection.
//
// `purge_trash` is driven from here too, as a job rather than its own timer. There used
// to be a second `setInterval` beside this one calling `trash.purgeExpired()` directly —
// the same timer that once took the whole process down for want of a `.catch` — which
// meant the Postgres root ran the sweep twice once `PgJobs.scheduleRecurring` gave it a
// real producer, and the in-memory root ran it only that way, since nothing scheduled the
// job there. `MemoryJobs` now has the same `scheduleRecurring` (see
// `packages/services-memory/src/index.ts`), so both roots run the sweep exactly once,
// through the queue, with a lease that survives a restart and a durable record of a
// failure — neither of which this timer had.
const jobTimer = setInterval(() => {
  void wiring.runJobs().catch((error: unknown) => {
    logger.error('job_failed', { error: error instanceof Error ? error.message : String(error) });
  });
}, 1000);

// Exports and deletions, on their own cadence. Ten seconds is a compromise: fast enough
// that a person who asked for an export is not left wondering, slow enough that a sweep
// which carries out irreversible deletions is not running constantly.
const accountTimer = setInterval(() => {
  void wiring
    .runAccountJobs()
    .then((result) => {
      if (result.exportsBuilt > 0) logger.info('exports_built', { count: result.exportsBuilt });
      if (result.archivesExpired > 0) {
        logger.info('export_archives_expired', { count: result.archivesExpired });
      }
      if (result.accountsDeleted > 0) {
        logger.info('accounts_deleted', { count: result.accountsDeleted });
      }
    })
    .catch((error: unknown) => {
      logger.error('account_jobs_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}, 10_000);

/**
 * The queue, said out loud on a cadence.
 *
 * `/v1/ops/queue` answers when someone asks, and the failure this is here for is exactly
 * the one nobody thinks to ask about: a stalled queue does not error, it simply stops
 * changing anything. A minute is often enough to notice within a deploy and rare enough
 * to read.
 *
 * `warn` when it is unhealthy and nothing at all when it is idle and clean, so a line here
 * always means something.
 */
const queueTimer = setInterval(() => {
  if (!wiring.queue) return;
  void wiring.queue
    .jobStats()
    .then(async (jobs) => {
      const exports = await wiring.queue!.exportStats();
      const unhealthy =
        jobs.expiredLeases > 0 ||
        jobs.failed > 0 ||
        exports.expiredLeases > 0 ||
        jobs.oldestPendingSeconds > 300;

      if (unhealthy) {
        logger.warn('queue_behind', {
          due: jobs.due,
          oldestPendingSeconds: jobs.oldestPendingSeconds,
          expiredLeases: jobs.expiredLeases,
          failed: jobs.failed,
          exportsStuck: exports.expiredLeases,
          exportsFailed: exports.failed,
        });
        return;
      }
      if (jobs.due > 0 || jobs.running > 0 || exports.pending > 0) {
        logger.info('queue', { due: jobs.due, running: jobs.running, exports: exports.pending });
      }
    })
    .catch((error: unknown) => {
      logger.error('queue_stats_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}, 60_000);

const server = serve(
  { fetch: wiring.app.fetch, hostname: config.host, port: config.port },
  (info) => {
    logger.info('listening', {
      port: info.port,
      publicUrl: config.publicUrl,
      mcpUrl: `${config.publicUrl}/mcp`,
      // Where a person is sent to approve a connection. Same origin when we serve the
      // browser app ourselves, a dev server otherwise — and getting this wrong is
      // invisible until someone tries to finish an OAuth flow in a browser.
      loginUrl: `${config.webUrl}/login`,
      servingWebApp: config.webDist !== null,
      // Said separately, because "the API is up" and "the product is reachable" were the
      // same log line once and that is how the product was unreachable for a whole
      // deploy without anyone seeing it.
      servingProductApp: config.appDist !== null,
    });
  },
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(jobTimer);
    clearInterval(accountTimer);
    clearInterval(queueTimer);
    alerting.watchdog.stop();
    server.close(() => {
      void wiring.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), config.shutdownGraceMs).unref();
  });
}
