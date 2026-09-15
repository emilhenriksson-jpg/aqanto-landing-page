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

import { databaseUrl } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

async function migrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
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

  // A database that received the schema before this ledger existed would try to
  // re-apply every file and fail on the first CREATE TYPE. If the core tables are
  // already there and the ledger is empty, record what is present rather than
  // running it again.
  if (applied.size === 0) {
    const existing = await pool.query<{ exists: boolean }>(
      `SELECT to_regclass('app.person') IS NOT NULL AS exists`,
    );
    if (existing.rows[0]?.exists) {
      for (const file of files) {
        await pool.query('INSERT INTO app.schema_migrations (id) VALUES ($1)', [file]);
        applied.add(file);
        console.log(`Noterade ${file} (fanns redan)`);
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

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl() });
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
