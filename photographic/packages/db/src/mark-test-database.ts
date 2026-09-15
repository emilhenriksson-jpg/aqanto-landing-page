/**
 * Marks the database in `DATABASE_URL` as disposable, so `reset()` will drop its schema.
 *
 * One table in `public`, which is where it has to live: the thing it authorises is
 * `DROP SCHEMA app CASCADE`, so a marker inside `app` would delete itself on first use
 * and the second run would refuse.
 *
 * Deliberately a separate step rather than something the suites do for you. The whole
 * point is that marking is an act someone performed on a database they are willing to
 * lose — if the tests could mark their own way past the guard, the guard would be a
 * comment.
 *
 * Usage: pnpm db:mark-test
 */

import { createPool } from './pool.js';
import { TEST_DATABASE_MARKER } from './reset.js';

const pool = createPool({ max: 1 });

try {
  const { rows } = await pool.query<{ name: string }>('SELECT current_database() AS name');
  const name = rows[0]?.name ?? '(okänd)';

  await pool.query(`CREATE TABLE IF NOT EXISTS ${TEST_DATABASE_MARKER} (
    marked_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(
    `COMMENT ON TABLE ${TEST_DATABASE_MARKER} IS ` +
      `'Märkt som slaskdatabas: reset() får släppa schemat app här. Skapad av pnpm db:mark-test.'`,
  );

  console.log(`"${name}" är märkt som testdatabas. reset() släpper schemat app här.`);
  console.log(`Ta bort märkningen med: DROP TABLE ${TEST_DATABASE_MARKER};`);
} finally {
  await pool.end();
}
