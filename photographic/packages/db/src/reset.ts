/**
 * Drops the `app` schema and re-migrates from nothing.
 *
 * For local development and the test suite only: it is the fast way back to a known
 * state when a migration needs rewriting or a test run left the database dirty. Never
 * called from anything that touches a real person's data.
 */

import { Pool } from 'pg';

import { migrate } from './migrate.js';
import { createPool } from './pool.js';

export async function reset(pool: Pool): Promise<string[]> {
  await pool.query('DROP SCHEMA IF EXISTS app CASCADE');
  return migrate(pool);
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    console.log('Släpper schemat app...');
    const ran = await reset(pool);
    console.log(`Migrerade om från grunden: ${ran.length} filer.`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
