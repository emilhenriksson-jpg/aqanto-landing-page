/**
 * One pass of every check, from a shell.
 *
 *   pnpm --filter @photographic/ops check            # print, do not send
 *   pnpm --filter @photographic/ops check -- --send  # print and send real alerts
 *
 * Three uses. After a deploy or a restore, to see the same picture the watchdog sees. From
 * a cron job on some other machine, as a second opinion that does not depend on this
 * process's own timer. And to test the channels — `--send --test` posts one harmless alert,
 * which is the only honest way to know a webhook URL or a phone number works before the
 * night it matters.
 *
 * Exits 0 when everything is ok, 1 when something is failing, 2 when it could not even run.
 */

import { createPool } from '@photographic/db';

import { createArchiveFromEnv } from '../archive.js';
import { runChecks } from '../checks.js';
import { deliveryCheck, DeliveryFailureLog, persistenceCheck } from '../checks.js';
import { documentBackupCheck } from '../document-backup.js';
import { postgresChecks } from '../postgres-checks.js';
import { AlertRouter } from '../router.js';
import { createAlertSinkFromEnv } from '../sinks.js';
import { resolveBlobStoreFromEnv } from '../blob-store.js';

const consoleLogger = {
  info: (message: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', msg: message, ...fields })),
  warn: (message: string, fields?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: 'warn', msg: message, ...fields })),
  error: (message: string, fields?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: 'error', msg: message, ...fields })),
};

async function main(): Promise<number> {
  const send = process.argv.includes('--send');
  const test = process.argv.includes('--test');

  const sinks = createAlertSinkFromEnv(process.env, { logger: consoleLogger });
  console.log(
    JSON.stringify({
      channels: sinks.kinds,
      logOnly: sinks.logOnly,
      environment: process.env.NODE_ENV ?? 'development',
    }),
  );

  if (test) {
    // Deliberately a `warning`: it exercises the webhook without pretending the memory is
    // on fire, and if it does not arrive that is the finding.
    await sinks.sink.send({
      key: 'alert_channel_test',
      status: 'failing',
      severity: 'warning',
      title: 'Testlarm från Photografic',
      detail: 'Ingen har gått sönder. Det här är ett medvetet test av larmvägen.',
      resolved: false,
      at: new Date(),
    });
    return 0;
  }

  const databaseUrl = process.env.DATABASE_URL;
  const storage = resolveBlobStoreFromEnv(process.env);
  const pool = databaseUrl ? createPool({ connectionString: databaseUrl }) : null;
  const archive = createArchiveFromEnv(process.env);

  try {
    const checks = [
      persistenceCheck({
        environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
        persistence: databaseUrl ? 'postgres' : 'memory',
        storageKind: storage.kind,
      }),
      ...(pool ? postgresChecks(pool) : []),
      ...(pool && archive
        ? [
            documentBackupCheck({
              db: pool,
              archive: archive.archive,
              maxAgeMs: archive.maxAgeMs,
              source: storage.blobs,
            }),
          ]
        : []),
      // Zero by definition from a fresh process: the counter lives in the API process, not
      // in the database. Included so the output lists every check rather than quietly
      // having one fewer than the running watchdog.
      deliveryCheck({ log: new DeliveryFailureLog() }),
    ];

    const results = await runChecks(checks);
    for (const result of results) console.log(JSON.stringify(result));

    if (send) {
      const router = new AlertRouter({ sink: sinks.sink });
      await router.route(results);
    }

    return results.some((result) => result.status !== 'ok') ? 1 : 0;
  } finally {
    await pool?.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  },
);
