/**
 * The migration runner's refusals, against a real database.
 *
 * These exist because renumbering turned out to be routine rather than rare — four
 * branches did it in one afternoon — and the ledger used to key on filename alone. None
 * of `0001`–`0017` are `IF NOT EXISTS`, so re-running one is a failed `CREATE TABLE` at
 * best and a destructive replay at worst, on the machine holding the only copy of
 * someone's memory.
 *
 * Every case here was first proven at a shell. That is not the same as a test: the next
 * renumber is protected by this file, not by anyone remembering the shell session.
 *
 * Each test gets its own database rather than its own schema, because the runner creates
 * `app` itself and owns the ledger; sharing one would make the cases depend on order.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rename, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate, MIGRATIONS_DIR } from './migrate.js';
import { createPool, databaseUrl } from './pool.js';

const ADMIN = databaseUrl();

async function databaseReachable(): Promise<boolean> {
  const probe = createPool({ connectionString: ADMIN, max: 1 });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

let reachable = false;
const created: string[] = [];
let workspace = '';

beforeAll(async () => {
  reachable = await databaseReachable();
  if (reachable) workspace = await mkdtemp(path.join(tmpdir(), 'migrate-'));
}, 30_000);

afterAll(async () => {
  if (!reachable) return;
  const admin = createPool({ connectionString: ADMIN, max: 1 });
  for (const name of created) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => {});
  }
  await admin.end().catch(() => {});
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

/** A fresh, empty database, and a pool pointing at it. */
async function freshDatabase(): Promise<Pool> {
  const name = `migrate_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = createPool({ connectionString: ADMIN, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end().catch(() => {});
  }
  created.push(name);

  const url = new URL(ADMIN);
  url.pathname = `/${name}`;
  return createPool({ connectionString: url.toString() });
}

/** A private copy of the real migrations, so a test can rename one without editing git. */
async function migrationsCopy(): Promise<string> {
  const dir = await mkdtemp(path.join(workspace, 'mig-'));
  for (const file of await readdir(MIGRATIONS_DIR)) {
    if (!file.endsWith('.sql')) continue;
    const sql = await readFileText(path.join(MIGRATIONS_DIR, file));
    await writeFile(path.join(dir, file), sql);
  }
  return dir;
}

async function readFileText(file: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(file, 'utf8');
}

async function ledger(pool: Pool): Promise<{ ids: string[]; withChecksum: number }> {
  const { rows } = await pool.query<{ id: string; checksum: string | null }>(
    'SELECT id, checksum FROM app.schema_migrations ORDER BY id',
  );
  return {
    ids: rows.map((r) => r.id),
    withChecksum: rows.filter((r) => r.checksum !== null).length,
  };
}

describe.skipIf(!process.env['DATABASE_URL'] && process.env['CI'] === 'true')(
  'migrate',
  () => {
    it('records a checksum for every migration it applies', async () => {
      if (!reachable) return;
      const pool = await freshDatabase();
      try {
        const dir = await migrationsCopy();
        const ran = await migrate(pool, dir);
        expect(ran.length).toBeGreaterThan(0);

        const { ids, withChecksum } = await ledger(pool);
        expect(withChecksum).toBe(ids.length);
        expect(ids).toEqual([...ids].sort());
      } finally {
        await pool.end();
      }
    }, 120_000);

    /**
     * The case that matters. A renumber must not re-run DDL, and the assertion is on the
     * returned list rather than on the schema: `migrate` returns what it executed, so an
     * empty list is a direct statement that nothing ran.
     */
    it('treats a renamed migration as the same migration', async () => {
      if (!reachable) return;
      const pool = await freshDatabase();
      try {
        const dir = await migrationsCopy();
        await migrate(pool, dir);
        const before = await ledger(pool);

        const last = before.ids[before.ids.length - 1];
        if (last === undefined) throw new Error('no migrations to rename');
        const renamed = last.replace(/^\d{4}/, '0099');
        await rename(path.join(dir, last), path.join(dir, renamed));

        const ran = await migrate(pool, dir);
        expect(ran).toEqual([]);

        const after = await ledger(pool);
        expect(after.ids).toHaveLength(before.ids.length);
        expect(after.ids).toContain(renamed);
        expect(after.ids).not.toContain(last);
      } finally {
        await pool.end();
      }
    }, 120_000);

    /**
     * Renamed *and* edited is not a rename anyone can recognise, and the two things it
     * might be need opposite handling — so it refuses. Without this the runner would
     * treat it as new and re-run DDL that is already applied.
     */
    it('refuses when a migration both changed name and changed content', async () => {
      if (!reachable) return;
      const pool = await freshDatabase();
      try {
        const dir = await migrationsCopy();
        const ran = await migrate(pool, dir);
        const last = ran[ran.length - 1];
        if (last === undefined) throw new Error('no migrations to rename');

        const renamed = last.replace(/^\d{4}/, '0099');
        await rename(path.join(dir, last), path.join(dir, renamed));
        await appendFile(path.join(dir, renamed), '\n-- a later edit\n');

        await expect(migrate(pool, dir)).rejects.toThrow(/inte finns på disk/);
      } finally {
        await pool.end();
      }
    }, 120_000);

    /**
     * The shape the live database was in before the checksum column existed: rows with
     * no checksum at all. A rename then cannot be recognised, and the runner has to stop
     * rather than replay — safe is the only acceptable direction to fail here.
     */
    it('refuses rather than replaying when the ledger predates checksums', async () => {
      if (!reachable) return;
      const pool = await freshDatabase();
      try {
        const dir = await migrationsCopy();
        const ran = await migrate(pool, dir);
        const last = ran[ran.length - 1];
        if (last === undefined) throw new Error('no migrations to rename');

        await pool.query('UPDATE app.schema_migrations SET checksum = NULL');
        await rename(path.join(dir, last), path.join(dir, last.replace(/^\d{4}/, '0099')));

        await expect(migrate(pool, dir)).rejects.toThrow(/inte finns på disk/);
      } finally {
        await pool.end();
      }
    }, 120_000);

    /**
     * Backfilling is what makes the protection cover the migrations that need it. An
     * already-applied ledger with no checksums gets them on the next ordinary run, with
     * the files still under their original names — which is the one moment the mapping
     * from name to content is still known.
     */
    it('backfills checksums for rows written before the column existed', async () => {
      if (!reachable) return;
      const pool = await freshDatabase();
      try {
        const dir = await migrationsCopy();
        await migrate(pool, dir);
        await pool.query('UPDATE app.schema_migrations SET checksum = NULL');

        const ran = await migrate(pool, dir);
        expect(ran).toEqual([]);

        const { ids, withChecksum } = await ledger(pool);
        expect(withChecksum).toBe(ids.length);
      } finally {
        await pool.end();
      }
    }, 120_000);

    /**
     * Not about renames, but it belongs beside them: two migrations sharing a number is
     * what caused four branches to renumber in the first place, and nothing checked it.
     */
    it('has no two migrations sharing a number, and they sort in order', async () => {
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
      const numbers = files.map((f) => f.slice(0, 4));
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(numbers).toEqual([...numbers].sort());
    });
  },
);
