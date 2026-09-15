/**
 * Postgres: the pool, the migrations, and — as the repositories land — the real
 * `Services` construction. Until those repositories exist, callers still use
 * `@photographic/services-memory`; setting `DATABASE_URL` without them is a loud
 * failure rather than a silent fall-back to memory.
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

export { migrate } from './migrate.js';
export { reset } from './reset.js';
