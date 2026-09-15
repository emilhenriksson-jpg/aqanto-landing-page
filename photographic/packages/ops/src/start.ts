/**
 * One function the process calls, so that turning alarms on is not a page of wiring.
 *
 * It reads the environment, picks the channels, assembles whichever checks the given
 * backend can actually answer, and starts the loop. Everything it decides is logged once at
 * boot, because "alerts are configured" and "alerts go to the log where nobody reads them"
 * are otherwise the same silence.
 */

import type { Check } from './alert.js';
import { createArchiveFromEnv } from './archive.js';
import { resolveBlobStoreFromEnv } from './blob-store.js';
import { deliveryCheck, DeliveryFailureLog, persistenceCheck, type PersistenceFacts } from './checks.js';
import { documentBackupCheck } from './document-backup.js';
import { postgresChecks, type Queryable } from './postgres-checks.js';
import { AlertRouter } from './router.js';
import { createAlertSinkFromEnv, type FetchLike, type SinkLogger } from './sinks.js';
import { createWatchdog, heartbeatFromEnv, type Watchdog } from './watchdog.js';

export interface AlertingInput {
  env: NodeJS.ProcessEnv;
  logger: SinkLogger;
  facts: PersistenceFacts;
  /**
   * The Postgres pool, or null on the in-memory path. Read-only use: four one-row queries
   * per pass, all against catalogues or aggregate counts.
   */
  db?: Queryable | null;
  /** The counter the code sender writes into. Omit to leave the delivery check out. */
  deliveryFailures?: DeliveryFailureLog;
  /** Injected in tests. */
  fetch?: FetchLike;
  /** Injected in tests. */
  now?: () => Date;
}

export interface Alerting {
  watchdog: Watchdog;
  /** Channels an alert will really go to. `['log']` means nobody. */
  channels: string[];
  checks: string[];
}

export function startAlerting(input: AlertingInput): Alerting {
  const { env, logger } = input;

  const sinks = createAlertSinkFromEnv(env, {
    logger,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const heartbeat = heartbeatFromEnv(env);

  const checks: Check[] = [persistenceCheck(input.facts)];
  if (input.db) checks.push(...postgresChecks(input.db));
  if (input.deliveryFailures) checks.push(deliveryCheck({ log: input.deliveryFailures }));

  // The document archive, when there is one. Its absence is not a silent gap: without it the
  // originals are the one part of a person's memory that cannot be recovered, because
  // Supabase's own backups cover the database and not the objects in Storage.
  const archive = createArchiveFromEnv(env, { ...(input.fetch ? { fetch: input.fetch } : {}) });
  if (input.db && archive) {
    checks.push(
      documentBackupCheck({
        db: input.db,
        archive: archive.archive,
        maxAgeMs: archive.maxAgeMs,
        // Both sides of the same sample, so an original disappearing from Storage is noticed
        // in a minute rather than at the next nightly run.
        source: resolveBlobStoreFromEnv(env).blobs,
        ...(input.now ? { now: input.now } : {}),
      }),
    );
  }

  const router = new AlertRouter({
    sink: sinks.sink,
    cooldownMs: minutesFromEnv(env.ALERT_COOLDOWN_MINUTES, 60) * 60_000,
    ...(input.now ? { now: input.now } : {}),
  });

  const watchdog = createWatchdog({
    checks,
    router,
    logger,
    ...(heartbeat ? { heartbeat: { ...heartbeat, ...(input.fetch ? { fetch: input.fetch } : {}) } } : {}),
    intervalMs: secondsFromEnv(env.WATCHDOG_INTERVAL_SECONDS, 60) * 1000,
    ...(input.now ? { now: input.now } : {}),
  });

  logger.info('alerting_selected', {
    channels: sinks.kinds.join(','),
    heartbeat: heartbeat !== null,
    checks: checks.map((check) => check.key).join(','),
  });

  // Said as a warning rather than refused at boot. The trade is deliberate: a process that
  // will not start because its alerting is unconfigured takes the memory offline to protect
  // the monitoring of the memory, which is the wrong way round. But it is a real gap and it
  // is stated in the words an operator can act on.
  if (sinks.logOnly && input.facts.environment === 'production') {
    logger.warn('alerting_not_configured', {
      detail:
        'Inga larmkanaler i produktion: sätt ALERT_WEBHOOK_URL och/eller ALERT_SMS_TO som ' +
        'Fly-secrets. Utan dem hamnar varje larm bara i loggen, vilket är samma läge som ' +
        'innan de fanns.',
    });
  }
  if (!heartbeat && input.facts.environment === 'production') {
    logger.warn('heartbeat_not_configured', {
      detail:
        'HEARTBEAT_URL är inte satt, så ingen upptäcker att maskinen är borta — den enda ' +
        'kontrollen som inte kan komma härifrån.',
    });
  }

  // Said at boot, every boot, until it is fixed. This is not a missing nice-to-have: it is
  // the one asymmetry in the recovery story that nobody would guess from outside — memories,
  // events, rooms and proposals come back from Supabase's daily backup, and the uploaded
  // originals do not come back at all.
  if (!archive && input.facts.environment === 'production') {
    const storage = resolveBlobStoreFromEnv(env);
    logger.warn('document_archive_not_configured', {
      storage: storage.kind,
      detail:
        'Inget dokumentarkiv: Supabases säkerhetskopior innehåller inte Storage, så ' +
        'originalen har ingen kopia någonstans och kan inte återställas — till skillnad ' +
        'från minnena. Sätt DOCUMENT_ARCHIVE_S3_* mot en annan leverantör.',
    });
  }

  watchdog.start();
  return { watchdog, channels: sinks.kinds, checks: checks.map((check) => check.key) };
}

function minutesFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function secondsFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 5 ? parsed : fallback;
}
