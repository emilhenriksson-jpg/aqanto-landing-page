/**
 * Connection pool and transaction plumbing.
 *
 * Everything else in this package takes a `Db` -- either the pool or a client already
 * inside a transaction -- as its first argument, so a repository call can be composed
 * into a larger unit of work without knowing whether one is already open.
 */

import { Pool } from 'pg';
import type { Pool as PgPool, PoolClient, PoolConfig, QueryResultRow } from 'pg';

/** Used when `DATABASE_URL` is unset. Matches the local development database. */
export const DEFAULT_DATABASE_URL =
  'postgres://photographic:photographic@127.0.0.1:5432/photographic';

/**
 * A pool or a client checked out of one. Repositories accept either so that a caller
 * can run several of them inside one transaction.
 */
export type Db = PgPool | PoolClient;

/** A client that is known to be inside a transaction. */
export type Tx = PoolClient;

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export function createPool(config: PoolConfig = {}): PgPool {
  return new Pool({
    connectionString: databaseUrl(),
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 10_000,
    ...config,
  });
}

let shared: PgPool | null = null;

/**
 * The process-wide pool. Adapters should use this; tests that need isolation can make
 * their own with `createPool`.
 */
export function getPool(): PgPool {
  if (!shared) {
    shared = createPool();
    // Without a listener an idle-client error takes the process down.
    shared.on('error', () => {});
  }
  return shared;
}

export async function closePool(): Promise<void> {
  if (shared) {
    const pool = shared;
    shared = null;
    await pool.end();
  }
}

export function isPool(db: Db): db is PgPool {
  return typeof (db as PgPool).totalCount === 'number';
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Clients we have opened a transaction on. `pg` exposes no way to ask a client whether
 * it is mid-transaction, and guessing wrong means either a nested BEGIN warning or a
 * COMMIT that ends someone else's unit of work, so we track it ourselves.
 */
const openTransactions = new WeakSet<PoolClient>();

let savepointCounter = 0;

export function inTransaction(db: Db): boolean {
  return !isPool(db) && openTransactions.has(db);
}

export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
export function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T>;
export function withTransaction<T>(
  dbOrFn: Db | ((tx: Tx) => Promise<T>),
  maybeFn?: (tx: Tx) => Promise<T>,
): Promise<T> {
  const db: Db = typeof dbOrFn === 'function' ? getPool() : dbOrFn;
  const fn = (typeof dbOrFn === 'function' ? dbOrFn : maybeFn) as (tx: Tx) => Promise<T>;
  return runInTransaction(db, fn);
}

async function runInTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (isPool(db)) {
    const client = await db.connect();
    try {
      return await onClient(client, fn);
    } finally {
      client.release();
    }
  }
  return onClient(db, fn);
}

async function onClient<T>(client: PoolClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (openTransactions.has(client)) return nested(client, fn);

  await client.query('BEGIN');
  openTransactions.add(client);
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    openTransactions.delete(client);
  }
}

async function nested<T>(client: PoolClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Generated here, never derived from input, so the identifier is safe to inline.
  const name = `photographic_sp_${++savepointCounter}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn(client);
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export async function queryRows<T extends QueryResultRow>(
  db: Db,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(text, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  db: Db,
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await queryRows<T>(db, text, params);
  return rows[0] ?? null;
}

export async function execute(
  db: Db,
  text: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const result = await db.query(text, params as unknown[]);
  return result.rowCount ?? 0;
}
