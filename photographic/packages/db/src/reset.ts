/**
 * Drops the `app` schema and re-migrates from nothing.
 *
 * For local development and the test suite only: it is the fast way back to a known
 * state when a migration needs rewriting or a test run left the database dirty. Never
 * called from anything that touches a real person's data.
 *
 * It refuses a database that was not marked as disposable, and that guard is not
 * defensive tidiness. Four suites in `packages/db` call this — `account`, `lifecycle`,
 * `documents` and `oauth` — so `pnpm test` against the database someone was working in
 * takes everything in it, with no prompt and no way back. `AGENTS.md:130` says the
 * opposite in as many words: "the database is shared between agents, so never `TRUNCATE`
 * and never assume an empty table." Dropping the whole schema is the stronger version of
 * the thing that document forbids, and the contradiction has been in the repository the
 * whole time.
 *
 * In CI it costs nothing, because the container is thrown away either way. The person it
 * costs is the newcomer who followed the instructions — was told how to get a database,
 * got one, put something in it, ran the tests. That is who this is for.
 */

import { Pool } from 'pg';

import { migrate } from './migrate.js';
import { createPool } from './pool.js';

/**
 * Lives in `public`, not in `app`, so it survives the `DROP SCHEMA` it authorises.
 * Created by `pnpm db:mark-test`.
 */
export const TEST_DATABASE_MARKER = 'public.photographic_test_database';

export interface ResetOptions {
  /**
   * Set by `pnpm db:reset`, where a person typed the word "reset" and meant it. The guard
   * exists for the implicit case — a test suite dropping a schema nobody asked it to
   * touch — not to argue with someone about their own command.
   */
  intentional?: boolean;
}

async function assertDisposable(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ name: string; marked: boolean }>(
    `SELECT current_database() AS name, to_regclass('${TEST_DATABASE_MARKER}') IS NOT NULL AS marked`,
  );
  const name = rows[0]?.name ?? '(okänd)';

  if (rows[0]?.marked) return;
  // Created by the e2e harness for a single run, from a name it derived itself.
  if (/_(e2e|test)$/.test(name)) return;
  if (process.env.PHOTOGRAPHIC_ALLOW_DESTRUCTIVE_TESTS === '1') return;

  throw new Error(
    [
      `Vägrar släppa schemat app i databasen "${name}".`,
      '',
      'reset() raderar allt i schemat, och den här databasen är inte utpekad som en',
      'testdatabas. Fyra sviter i packages/db anropar den, så tester mot databasen du',
      'arbetar i tar med sig det du la där — utan att fråga och utan väg tillbaka.',
      '',
      'Är den en slaskdatabas? Märk den en gång:',
      '',
      '  pnpm db:mark-test',
      '',
      'Vill du behålla innehållet? Peka testerna någon annanstans:',
      '',
      '  createdb photographic_test',
      '  DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic_test \\',
      '    pnpm db:migrate && pnpm test',
      '',
      'Databaser vars namn slutar på _test eller _e2e släpps igenom utan märkning, eftersom',
      'de skapas av sviterna själva. PHOTOGRAPHIC_ALLOW_DESTRUCTIVE_TESTS=1 kringgår spärren',
      'helt, om du har en uppsättning som inget av ovanstående passar.',
    ].join('\n'),
  );
}

export async function reset(pool: Pool, options: ResetOptions = {}): Promise<string[]> {
  if (!options.intentional) await assertDisposable(pool);
  await pool.query('DROP SCHEMA IF EXISTS app CASCADE');
  return migrate(pool);
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    console.log('Släpper schemat app...');
    const ran = await reset(pool, { intentional: true });
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
