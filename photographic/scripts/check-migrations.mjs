/**
 * Refuses two migrations with the same number, and a gap in the sequence.
 *
 * Three branches landed on `0016` in one afternoon. That is a merge-day surprise, and it
 * is avoidable at pull-request time for about forty lines, because the information needed
 * to spot it is just a directory listing.
 *
 * Why it matters more than tidiness: `packages/db/src/migrate.ts` sorts the directory by
 * filename and keys the ledger on the filename too. So two files sharing a number apply
 * in alphabetical order — `0003_provenance_and_authorship.sql` before
 * `0003_swedish_search.sql`, decided by `p` coming before `s` and by nothing else — and
 * whichever author assumed the other order finds out in production. The ledger keying on
 * filename has a second edge: renaming a migration to fix its number makes it run again
 * on every database that already applied it, so a collision caught after a deploy cannot
 * be fixed by renumbering. That is the whole reason this belongs at pull-request time.
 *
 * A gap is the weaker signal and still worth failing on: `0004` jumping to `0010` is how
 * the next person ends up looking for five files that were never written, and a gap in a
 * fresh sequence usually means a file was deleted rather than skipped on purpose.
 *
 * Both of the things already on `main` are recorded below rather than fixed. The `0003`
 * pair cannot be renumbered now for the reason above — production has applied them — and
 * the gap is history. Recording them is what lets the check be an error rather than a
 * warning nobody reads.
 *
 * Usage: node scripts/check-migrations.mjs
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'packages', 'db', 'migrations');

/** `0016_app_role_grants.sql`. Four digits, snake_case, `.sql`. */
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * On `main` before this check existed. Neither can be fixed by renumbering: the ledger
 * keys on filename, so a rename re-runs the file on every database that has it.
 */
const ALLOWED_DUPLICATES = ['0003'];
const ALLOWED_GAPS = [5, 6, 7, 8, 9];

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const problems = [];
const byNumber = new Map();

for (const file of files) {
  const match = NAME.exec(file);
  if (!match) {
    problems.push(
      `${file} är inte namngiven \`NNNN_snake_case.sql\`. Migreringsordningen är ` +
        `filnamnssortering (packages/db/src/migrate.ts), så ett avvikande namn sorterar ` +
        `någon annanstans än där författaren tror.`,
    );
    continue;
  }
  const number = match[1];
  byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
}

for (const [number, sharing] of byNumber) {
  if (sharing.length === 1 || ALLOWED_DUPLICATES.includes(number)) continue;
  problems.push(
    `${sharing.length} migreringar delar numret ${number}:\n    ${sharing.join('\n    ')}\n` +
      `  De körs i filnamnsordning, vilket avgörs av bokstäverna efter numret och av ` +
      `ingenting annat.\n  Numrera om den som kom sist — efter en deploy går det inte, ` +
      `för liggaren nycklar på filnamn och en omdöpt fil körs igen.`,
  );
}

const numbers = [...byNumber.keys()].map(Number).sort((a, b) => a - b);
const highest = numbers.at(-1) ?? 0;

for (let n = 1; n <= highest; n += 1) {
  if (numbers.includes(n) || ALLOWED_GAPS.includes(n)) continue;
  problems.push(
    `Nummer ${String(n).padStart(4, '0')} saknas i sekvensen, som annars går 0001–` +
      `${String(highest).padStart(4, '0')}. Antingen raderades en fil, eller så hoppades ` +
      `numret över — och i det andra fallet hör det i ALLOWED_GAPS i den här filen med ett skäl.`,
  );
}

console.log(`${files.length} migreringar, 0001–${String(highest).padStart(4, '0')}.`);
console.log(`Nästa lediga nummer: ${String(highest + 1).padStart(4, '0')}.`);

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('Inga kolliderande eller saknade nummer.');
