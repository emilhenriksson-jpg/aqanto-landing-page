/**
 * Postgres: the pool, the migrations, and the real `Services` construction.
 *
 * Callers that set `DATABASE_URL` get `createPostgresServices`. Until the ports
 * existed that was a loud failure; now it is the production path.
 */

export {
  DEFAULT_DATABASE_URL,
  closePool,
  createPool,
  databaseUrl,
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
export { reset } from './reset.js';

export {
  createPostgresServices,
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
