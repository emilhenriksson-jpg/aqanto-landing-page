/**
 * Applies migration SQL files in order.
 *
 * Tracked in `app.schema_migrations`, created here if missing. Each file runs inside its
 * own transaction: a migration that fails halfway must not be recorded as applied, or a
 * re-run would skip the half that never happened.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { createPool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

async function migrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

/**
 * One arbitrary constant, so every process asking for this lock asks for the same one.
 *
 * `pg_advisory_lock` is per-database and session-scoped, which is exactly the shape
 * needed here: two machines booting at once — a rolling deploy, or any future scaling —
 * otherwise run the same file against the same schema simultaneously, and the loser gets
 * a duplicate-object error that looks like a broken migration rather than a race.
 */
const MIGRATION_LOCK_KEY = 8_531_207_413_004_112n;

export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  // Taken on one checked-out client for the whole run, not on the pool: an advisory lock
  // belongs to a session, so acquiring it on a pooled connection and releasing it on
  // another would be a lock nobody holds.
  const gate = await pool.connect();
  try {
    await gate.query('SELECT pg_advisory_lock($1)', [String(MIGRATION_LOCK_KEY)]);
    return await runMigrations(pool, dir);
  } finally {
    await gate.query('SELECT pg_advisory_unlock($1)', [String(MIGRATION_LOCK_KEY)]).catch(() => {
      // Releasing is best-effort: the lock dies with the session either way, and a
      // failure here must not mask a migration error on the way out.
    });
    gate.release();
  }
}

async function runMigrations(pool: Pool, dir: string): Promise<string[]> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;
    CREATE TABLE IF NOT EXISTS app.schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await pool.query<{ id: string }>('SELECT id FROM app.schema_migrations');
  const applied = new Set(rows.map((r) => r.id));
  const files = await migrationFiles(dir);

  /**
   * Adopting a schema that predates this ledger — now something a human asks for.
   *
   * The original rule was "if `app.person` exists and the ledger is empty, mark every
   * file on disk as applied". The intent was right and the condition was not: it tests
   * an artefact of the *first* migration and then writes off *all* of them. A database
   * restored from a backup taken at `0004` satisfies it exactly, and comes out with
   * `0010`–`0015` recorded as applied without any of them having run. Nothing errors;
   * the schema is permanently missing most of its tables and the failures land far from
   * the cause. It is the only path in the repo that can make the schema silently wrong,
   * and it fires precisely in the situation where someone is already having a bad day.
   *
   * So the guess is gone. `MIGRATIONS_ADOPT_BASELINE=<filename>` records everything up
   * to and including that file and no further, which is a claim only a person looking at
   * the database can make. Without it, an existing schema with an empty ledger is a
   * refusal rather than an assumption — loud, and recoverable by setting the variable.
   */
  if (applied.size === 0) {
    const existing = await pool.query<{ exists: boolean }>(
      `SELECT to_regclass('app.person') IS NOT NULL AS exists`,
    );

    if (existing.rows[0]?.exists) {
      const baseline = process.env.MIGRATIONS_ADOPT_BASELINE?.trim();

      if (!baseline) {
        throw new Error(
          'Schemat finns redan (app.person) men app.schema_migrations är tom. Det går ' +
            'inte att gissa vilka migrationer som körts: en databas återställd från en ' +
            'äldre backup ser identisk ut och skulle få alla filer markerade som körda ' +
            'utan att någon kört. Sätt MIGRATIONS_ADOPT_BASELINE till den sista ' +
            'migrationsfil som faktiskt är applicerad, t.ex. ' +
            `MIGRATIONS_ADOPT_BASELINE=${files[0] ?? '0001_init.sql'}`,
        );
      }

      if (!files.includes(baseline)) {
        throw new Error(
          `MIGRATIONS_ADOPT_BASELINE=${baseline} finns inte bland migrationsfilerna.`,
        );
      }

      for (const file of files) {
        await pool.query('INSERT INTO app.schema_migrations (id) VALUES ($1)', [file]);
        applied.add(file);
        console.log(`Noterade ${file} (fanns redan)`);
        if (file === baseline) break;
      }
    }
  }

  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO app.schema_migrations (id) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migrering ${file} misslyckades: ${(error as Error).message}`, {
        cause: error,
      });
    } finally {
      client.release();
    }
  }

  return ran;
}

// `createPool`, not a bare `new Pool`: this is the process the Dockerfile runs at boot,
// so it is the one path that must not connect in plaintext. `pg` defaults to no TLS and
// Supabase's pooler accepts that, so a bare pool here migrates a database of private
// memory over an unencrypted socket without erroring. Measured, not assumed.
/**
 * Migrations connect as a different, more privileged role than the app.
 *
 * `MIGRATION_DATABASE_URL` if set, otherwise `DATABASE_URL` — so nothing changes until an
 * operator has actually created the restricted role and is ready to point the app at it.
 * The split exists because the two need opposite things: migrations need DDL on the whole
 * `app` schema, and the application needs no DDL at all. One role for both means any
 * injection or mistake in application code reaches `DROP TABLE`, which for this product is
 * the entire memory rather than a bounded slice. See `scripts/deploy.md`.
 */
async function main(): Promise<void> {
  const pool = createPool(
    process.env.MIGRATION_DATABASE_URL
      ? { connectionString: process.env.MIGRATION_DATABASE_URL }
      : {},
  );
  try {
    const ran = await migrate(pool);
    if (ran.length === 0) {
      console.log('Inget att migrera. Schemat är redan à jour.');
    } else {
      for (const file of ran) console.log(`Körde ${file}`);
    }
  } finally {
    await pool.end();
  }
}

// Only run as a script, not when imported (e.g. by tests or reset.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
