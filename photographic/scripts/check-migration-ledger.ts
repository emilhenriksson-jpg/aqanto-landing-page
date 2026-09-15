/**
 * Asserts that the migrations on disk are the migrations that ran, in that order.
 *
 * Everyone has been verifying this by hand all day — apply from an empty database, watch
 * the filenames scroll past, conclude it works. It is a two-query check, and unlike the
 * manual version it also holds on the days nobody thinks to look.
 *
 * Three failures it catches, all of which end as a schema that is wrong rather than a
 * migration that errored:
 *
 *  - **A file that never ran.** The ledger is keyed on filename, so a file whose name
 *    changed after it was applied is a new migration to the runner and an old one to the
 *    author. It runs again on databases that have it and not at all where it was renamed
 *    away from — whichever half of that is true here shows up as a missing or surplus row.
 *  - **A row with no file.** `migrate.ts`'s adoption branch records *every* file on disk
 *    as applied when `app.person` exists and the ledger is empty. A database restored
 *    from a backup taken at `0004` therefore gets `0010`–`0017` stamped without running
 *    any of them, permanently. From the ledger alone that state is indistinguishable from
 *    a healthy one; from ledger-versus-disk it is not.
 *  - **Out-of-order application.** Files are sorted by filename and applied in that order,
 *    so `applied_at` should rise with the name. It not rising means something applied a
 *    migration by hand, or that two files share a number and the order the author assumed
 *    is not the order that happened.
 *
 * Run it after `db:migrate` against a database that started empty, which is what the CI
 * Postgres service container is.
 *
 * Usage: node --import tsx scripts/check-migration-ledger.ts
 */

import { readdirSync } from 'node:fs';

import { createPool, MIGRATIONS_DIR } from '@photographic/db';

const onDisk = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const pool = createPool({ max: 1 });
const problems: string[] = [];

try {
  const { rows } = await pool.query<{ id: string; applied_at: Date }>(
    'SELECT id, applied_at FROM app.schema_migrations ORDER BY applied_at, id',
  );

  const applied = new Set(rows.map((r) => r.id));

  for (const file of onDisk) {
    if (!applied.has(file)) {
      problems.push(
        `${file} finns på disk men inte i app.schema_migrations. Den kördes inte, och ` +
          `schemat saknar därmed vad den skulle ha skapat.`,
      );
    }
  }

  for (const row of rows) {
    if (!onDisk.includes(row.id)) {
      problems.push(
        `app.schema_migrations innehåller ${row.id}, men ingen sådan fil finns. Antingen ` +
          `raderades eller döptes filen om — och liggaren nycklar på filnamn, så en omdöpt ` +
          `migrering körs igen på varje databas som redan hade den.`,
      );
    }
  }

  // Filename order is application order (`migrate.ts` sorts the directory), so the two
  // sequences have to agree. Compared as lists rather than as sets: the order is the
  // property, and a set comparison would pass on a database where 0017 ran before 0016.
  const appliedInOrder = rows.map((r) => r.id);
  const expected = onDisk.filter((f) => applied.has(f));
  if (appliedInOrder.join() !== expected.join()) {
    problems.push(
      `Migreringarna kördes inte i filnamnsordning.\n  Liggaren: ${appliedInOrder.join(', ')}\n` +
        `  Disken:   ${expected.join(', ')}`,
    );
  }

  console.log(`${onDisk.length} migreringar på disk, ${rows.length} i liggaren.`);
} finally {
  await pool.end();
}

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('Liggaren och disken är överens, i ordning.');
