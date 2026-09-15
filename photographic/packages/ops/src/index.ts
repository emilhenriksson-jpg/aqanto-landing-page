/**
 * `@photographic/ops` — the layer above the metrics: something that reaches a human.
 *
 * The premise of this package is a fact about this project's history rather than a
 * preference: every failure so far was found by a person noticing that something looked
 * wrong. Health endpoints, log lines and counters were all present for most of them. So
 * the unit of work here is not a measurement, it is a message that arrives — and
 * everything else exists to keep that message rare enough to still be read.
 *
 * Sized for what is actually deployed: one Fly machine, one owner, one phone. No metrics
 * backend, no dashboard, no agent to install. Five checks, two channels, and an external
 * dead-man's switch for the case where this process cannot speak for itself.
 *
 * ```ts
 * const alerting = startAlerting({
 *   env: process.env,
 *   logger,
 *   facts: { environment, persistence, storageKind },
 *   db: pool,                       // null on the in-memory path
 *   deliveryFailures,
 * });
 * // …
 * alerting.watchdog.stop();
 * ```
 *
 * `pnpm --filter @photographic/ops check` runs one pass from a shell — the same checks,
 * printed as JSON, exiting non-zero when something is failing. That is the version to run
 * from `fly ssh console`, from a cron job on another machine, or by hand after a restore.
 */

export {
  formatAlert,
  failing,
  ok,
  type Alert,
  type AlertSink,
  type Check,
  type CheckResult,
  type CheckStatus,
  type Severity,
} from './alert.js';

export {
  countingCodeSender,
  deliveryCheck,
  DeliveryFailureLog,
  persistenceCheck,
  runChecks,
  type CodeSenderLike,
  type PersistenceFacts,
} from './checks.js';

export {
  deletionCheck,
  exportCheck,
  jobQueueCheck,
  migrationCheck,
  MIGRATION_ARTIFACTS,
  postgresChecks,
  type Queryable,
} from './postgres-checks.js';

export { AlertRouter, type AlertRouterOptions } from './router.js';

export {
  createAlertSinkFromEnv,
  FanOutAlertSink,
  LogAlertSink,
  SmsAlertSink,
  WebhookAlertSink,
  type AlertSinkSelection,
  type FetchLike,
  type SinkLogger,
} from './sinks.js';

export {
  createWatchdog,
  heartbeatFromEnv,
  type HeartbeatOptions,
  type Watchdog,
  type WatchdogPass,
} from './watchdog.js';

export { startAlerting, type Alerting, type AlertingInput } from './start.js';

export { resolveBlobStoreFromEnv, type ResolvedBlobStore } from './blob-store.js';

export {
  diffFingerprints,
  FINGERPRINTED_TABLES,
  takeFingerprint,
  verifyDocuments,
  type DocumentVerification,
  type FingerprintDifference,
  type MemoryFingerprint,
  type TableFingerprint,
} from './fingerprint.js';
