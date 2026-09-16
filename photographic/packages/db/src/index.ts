/**
 * Postgres: the pool, the migrations, and the real `Services` construction.
 *
 * Callers that set `DATABASE_URL` get `createPostgresServices`. Until the ports
 * existed that was a loud failure; now it is the production path.
 */

export {
  BUNDLED_CA_PATH,
  DatabaseTlsError,
  SUPABASE_ROOT_CA_SHA256,
  isLoopbackHost,
  resolveDatabaseTls,
  type CaSource,
  type DatabaseTls,
} from './tls.js';

export {
  DEFAULT_DATABASE_URL,
  closePool,
  createPool,
  databaseUrl,
  describeDatabaseTls,
  execute,
  getPool,
  inTransaction,
  isPool,
  queryOne,
  queryRows,
  withTransaction,
  type Db,
  type Tx,
} from './pool.js';

export { migrate, MIGRATIONS_DIR } from './migrate.js';
export { PgStorageLedger } from './services/storage-ledger.js';

/**
 * Export and account deletion.
 *
 * Exported beside `Services` rather than inside it: both are lifecycle operations on an
 * account rather than reads or writes of memory, and both need the storage port
 * directly — an export writes an archive through it and a deletion removes files
 * through it.
 */
export {
  AccountFrozenError,
  PgAccounts,
  type ContributionChoice,
  type DeletionRequest,
} from './services/account.js';
export {
  DOWNLOAD_TOKEN_PREFIX,
  DOWNLOAD_TTL_SECONDS,
  PgExports,
  type ExportJobRecord,
  type ExportStatus,
} from './services/exports.js';
export { PgExportSource } from './services/export-source.js';
export { reset } from './reset.js';

export {
  createPostgresServices,
  // Exported so the composition root can resolve the same default the services would,
  // rather than having a second one that could disagree — an export reading from one
  // place while uploads write to another is a bug with no error message.
  defaultBlobRoot,
  type PostgresServices,
  type PostgresServicesOptions,
} from './postgres-services.js';

/**
 * The OAuth stores, exported separately from `Services`.
 *
 * They are not ports in `@photographic/core` — the authorization server declares its own
 * narrow persistence interfaces so it can be built and tested without a database — so
 * the composition root in `apps/rest` picks these up directly, the same way it picks up
 * the in-memory ones when there is no `DATABASE_URL`.
 */
export {
  PgAuthCodeStore,
  PgClientGrants,
  PgOAuthClientStore,
  PgPendingAuthorizationStore,
  PgTokenStore,
  type ClientGrantRow,
} from './services/oauth.js';

export { PgBrowserSessionRevocations } from './services/browser-sessions.js';
