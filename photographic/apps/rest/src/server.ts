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

// Background work runs on a timer rather than a separate worker process, which is right
// for development and is the first thing to split out when there is more than one
// instance: two processes sweeping the same queue would each rebuild every projection.
const jobTimer = setInterval(() => {
  void wiring.runJobs().catch((error: unknown) => {
    logger.error('job_failed', { error: error instanceof Error ? error.message : String(error) });
  });
}, 1000);

const purgeTimer = setInterval(() => {
  void wiring.purgeTrash().then((count) => {
    if (count > 0) logger.info('trash_purged', { count });
  });
}, 60_000);

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
    clearInterval(purgeTimer);
  clearInterval(accountTimer);
    server.close(() => {
      void wiring.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), config.shutdownGraceMs).unref();
  });
}
