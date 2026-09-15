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
