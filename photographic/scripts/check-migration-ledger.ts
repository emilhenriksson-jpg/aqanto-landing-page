/**
 * Asserts that the migrations on disk are the migrations that ran, unedited since.
 *
 * Everyone has been verifying the first half of this by hand — apply from an empty
 * database, watch the filenames scroll past, conclude it works. It is two queries, and
 * unlike the manual version it also holds on the days nobody thinks to look.
 *
 * What this adds over the runner's own guards, because `migrate.ts` acquired several of
 * its own and a check that only repeats them is noise:
 *
 *  - **Content drift.** Every ledger row carries a checksum, and the runner compares them
 *    only to recognise a rename. Nothing notices an *applied* migration whose file was
 *    edited in place: the runner sees a filename it has already recorded, skips it, and
 *    the schema silently stops matching the file that claims to describe it. Reviewers
 *    read the file. This is the check for the gap between them.
 *  - **An independent reading.** The runner refusing orphans is the runner asserting its
 *    own correctness. Asking the database afterwards is a different question, and it is
 *    the one that survives a refactor of the runner.
 *
 * What it deliberately does *not* assert: that `applied_at` rises with the filename.
 * That was in the first version and it was wrong. `migrate.ts` now recognises a renamed
 * migration by content and moves the ledger row to the new name while keeping the
 * original `applied_at` — which is correct, and which means a renumbered migration has a
 * timestamp that does not match its new position. Four branches renumbered in one
 * afternoon here, so that is the normal case and not the exception. Ordering is only a
 * real property of a run that started from nothing, which is what `--from-empty` is for
 * and why CI is the only place that passes it.
 *
 * Usage: node --import tsx scripts/check-migration-ledger.ts [--from-empty]
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createPool, MIGRATIONS_DIR } from '@photographic/db';

const fromEmpty = process.argv.includes('--from-empty');

const onDisk = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/** The same normalisation `migrate.ts` uses, so the two agree about what a file contains. */
const checksums = new Map(
  onDisk.map((file) => [
    file,
    createHash('sha256')
      .update(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n/g, '\n'), 'utf8')
      .digest('hex'),
  ]),
);

const pool = createPool({ max: 1 });
const problems: string[] = [];

try {
  // `migrate.ts` adds this column on every run, so its absence means the runner has not
  // been here since checksums landed — a clearer thing to say than a raw column error.
  const shape = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'schema_migrations'
          AND column_name = 'checksum'
     ) AS ok`,
  );
  if (!shape.rows[0]?.ok) {
    throw new Error(
      'app.schema_migrations har ingen checksum-kolumn, så migrate.ts har inte körts mot ' +
        'den här databasen sedan innehållsnycklingen landade. Kör `pnpm db:migrate` först.',
    );
  }

  const { rows } = await pool.query<{ id: string; applied_at: Date; checksum: string | null }>(
    'SELECT id, applied_at, checksum FROM app.schema_migrations ORDER BY applied_at, id',
  );
  const applied = new Map(rows.map((r) => [r.id, r]));

  for (const file of onDisk) {
    const row = applied.get(file);
    if (!row) {
      problems.push(
        `${file} finns på disk men inte i app.schema_migrations. Den kördes inte, och ` +
          `schemat saknar därmed vad den skulle ha skapat.`,
      );
      continue;
    }
    if (row.checksum !== null && row.checksum !== checksums.get(file)) {
      problems.push(
        `${file} har ändrats sedan den kördes. Liggarens checksumma matchar inte filens ` +
          `innehåll.\n  Runnern kör inte om en fil den redan noterat, så schemat i ` +
          `databasen är inte längre det som står i filen — och filen är den en granskare ` +
          `läser.\n  Antingen hör ändringen i en ny migrering, eller så är den redan ` +
          `applicerad för hand och då ska checksumman uppdateras medvetet.`,
      );
    }
  }

  for (const row of rows) {
    if (!onDisk.includes(row.id)) {
      problems.push(
        `app.schema_migrations innehåller ${row.id}, men ingen sådan fil finns. En ` +
          `migrering som körts och sedan raderats lämnar schemat med objekt som ingen fil ` +
          `längre beskriver.`,
      );
    }
  }

  if (fromEmpty) {
    // Only meaningful because this run started from an empty database: no rename can have
    // moved a row's name without its timestamp.
    const order = rows.map((r) => r.id);
    const expected = onDisk.filter((f) => applied.has(f));
    if (order.join() !== expected.join()) {
      problems.push(
        `Migreringarna kördes inte i filnamnsordning, i en körning som startade från en ` +
          `tom databas.\n  Liggaren: ${order.join(', ')}\n  Disken:   ${expected.join(', ')}`,
      );
    }
  }

  const unsummed = rows.filter((r) => r.checksum === null).length;
  console.log(
    `${onDisk.length} migreringar på disk, ${rows.length} i liggaren` +
      `${unsummed > 0 ? `, ${unsummed} utan checksumma` : ''}` +
      `${fromEmpty ? ', ordning kontrollerad' : ''}.`,
  );
} finally {
  await pool.end();
}

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('Liggaren och disken är överens.');
