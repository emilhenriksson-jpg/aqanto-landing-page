/**
 * Applies migration SQL files in order.
 *
 * Tracked in `app.schema_migrations`, created here if missing. Each file runs inside its
 * own transaction: a migration that fails halfway must not be recorded as applied, or a
 * re-run would skip the half that never happened.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { createPool, DEFAULT_DATABASE_URL } from './pool.js';

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

/**
 * What a migration file contains, independent of what it is called.
 *
 * Normalised on line endings before hashing so that a checkout on a machine with
 * different `core.autocrlf` does not read as a different migration.
 */
function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

async function runMigrations(pool: Pool, dir: string): Promise<string[]> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;
    CREATE TABLE IF NOT EXISTS app.schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE app.schema_migrations ADD COLUMN IF NOT EXISTS checksum text;
  `);

  const { rows } = await pool.query<{ id: string; checksum: string | null }>(
    'SELECT id, checksum FROM app.schema_migrations',
  );
  const applied = new Set(rows.map((r) => r.id));
  const files = await migrationFiles(dir);

  // Read every file up front: the ledger is now keyed on content as well as name, and
  // both questions below need the contents of files that may never be executed.
  const contents = new Map<string, string>();
  for (const file of files) contents.set(file, await readFile(path.join(dir, file), 'utf8'));
  const sums = new Map([...contents].map(([file, sql]) => [file, checksumOf(sql)]));

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
        await pool.query('INSERT INTO app.schema_migrations (id, checksum) VALUES ($1, $2)', [
          file,
          sums.get(file) ?? null,
        ]);
        applied.add(file);
        console.log(`Noterade ${file} (fanns redan)`);
        if (file === baseline) break;
      }
    }
  }

  /**
   * Renaming a migration must not re-run it.
   *
   * The ledger keyed on filename alone, and every renumber today moved files that were
   * already applied. `0001`–`0017` contain no `IF NOT EXISTS`, so re-running one is not
   * a no-op — it is a failed `CREATE TABLE` at best and a destructive replay at worst,
   * discovered on the machine that has the only copy of someone's memory. Four branches
   * renumbered in a single afternoon, which makes this a routine operation rather than a
   * rare one.
   *
   * So identity moves to the content. Three steps, in this order, because each one makes
   * the next answerable:
   *
   * 1. Backfill checksums for rows recorded before this column existed. Without it the
   *    protection would only cover migrations applied from now on, which is precisely the
   *    wrong set — the live database has seventeen rows with no checksum, and those are
   *    the ones being renumbered.
   * 2. Treat an unknown filename whose content matches a ledger entry that no longer has
   *    a file as that entry, renamed. Record the new name; run nothing.
   * 3. Refuse the ambiguous case rather than guessing, below.
   */
  const ledger = new Map(rows.map((r) => [r.id, r.checksum]));

  for (const [id, checksum] of ledger) {
    const sum = sums.get(id);
    if (checksum !== null || sum === undefined) continue;
    await pool.query('UPDATE app.schema_migrations SET checksum = $2 WHERE id = $1', [id, sum]);
    ledger.set(id, sum);
  }

  const orphaned = [...ledger].filter(([id]) => !files.includes(id));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sum = sums.get(file);
    const match = orphaned.find(([, checksum]) => checksum !== null && checksum === sum);
    if (!match) continue;

    const [oldId] = match;
    await pool.query('UPDATE app.schema_migrations SET id = $2 WHERE id = $1', [oldId, file]);
    applied.add(file);
    ledger.delete(oldId);
    orphaned.splice(orphaned.indexOf(match), 1);
    console.log(`${oldId} heter nu ${file} — samma innehåll, körs inte igen.`);
  }

  /**
   * Content and name both changed, or an applied migration was deleted.
   *
   * Either way this is not a rename that can be recognised, and the two possibilities
   * need opposite responses: a genuinely new migration should run, and an edited copy of
   * one already applied must not. Nothing in the filesystem distinguishes them, so this
   * refuses and says what it saw. `MIGRATIONS_ALLOW_ORPHANS=1` is the way through for the
   * case where a migration really was deleted on purpose.
   */
  const pending = files.filter((file) => !applied.has(file));
  if (orphaned.length > 0 && process.env.MIGRATIONS_ALLOW_ORPHANS !== '1') {
    throw new Error(
      `Migrationer som är körda men inte finns på disk: ${orphaned.map(([id]) => id).join(', ')}.` +
        (pending.length > 0
          ? ` Samtidigt finns ${pending.join(', ')} som inte är körda. Om en fil både ` +
            'bytt namn och ändrats går det inte att avgöra om den redan är applicerad, ' +
            'och att gissa fel betyder antingen en migrering som körs två gånger eller ' +
            'en som aldrig körs. Återställ filnamnet, eller dela upp ändringen i ett ' +
            'namnbyte och en ny migrering.'
          : ' Har de tagits bort med avsikt? Sätt MIGRATIONS_ALLOW_ORPHANS=1.'),
    );
  }

  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = contents.get(file) ?? '';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO app.schema_migrations (id, checksum) VALUES ($1, $2)', [
        file,
        sums.get(file) ?? null,
      ]);
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
  const configured = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  const pool = createPool(
    process.env.MIGRATION_DATABASE_URL
      ? { connectionString: process.env.MIGRATION_DATABASE_URL }
      : {},
  );

  // Say which database is about to be changed, before changing it.
  //
  // With neither variable set, `databaseUrl()` falls back to the local development
  // default and this ran DDL against whatever is on localhost without mentioning it. The
  // container never hits that -- `CMD` guards on `DATABASE_URL` being set -- so the person
  // it misleads is the next one to run `pnpm db:migrate` on a laptop, who reads "Inget att
  // migrera" as a statement about the database they had in mind rather than about a local
  // one they had forgotten. The fallback itself stays: local development depends on it,
  // and refusing here would break the documented workflow to fix a reporting problem.
  const target = configured
    ? new URL(configured).host
    : `${new URL(DEFAULT_DATABASE_URL).host} (DATABASE_URL är inte satt — lokal standard)`;
  console.log(`Migrerar ${target}`);

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
