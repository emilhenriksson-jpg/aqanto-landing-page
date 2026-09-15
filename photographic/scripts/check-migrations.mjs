/**
 * Refuses two migrations with the same number, and a gap in the sequence.
 *
 * Three branches landed on `0016` in one afternoon. That is a merge-day surprise, and it
 * is avoidable at pull-request time for about forty lines, because the information needed
 * to spot it is just a directory listing.
 *
 * Why it matters more than tidiness: `packages/db/src/migrate.ts` sorts the directory by
 * filename and applies in that order. So two files sharing a number apply in alphabetical
 * order — `0003_provenance_and_authorship.sql` before `0003_swedish_search.sql`, decided
 * by `p` coming before `s` and by nothing else — and whichever author assumed the other
 * order finds out in production, where the two files touch the same table.
 *
 * An earlier version of this comment also said a collision could not be fixed by
 * renumbering after a deploy, because the ledger keyed on filename and a rename re-ran
 * the file. That is no longer true: the ledger keys on content as well as name, and
 * `migrate.ts` recognises a renamed migration and moves the row instead of running it.
 * Renumbering is therefore recoverable now. The check is still worth having — four
 * branches renumbered in a single afternoon, which is how three of them landed on `0016`
 * in the first place, and the apply-order hazard above is untouched by any of that — but
 * it is a check against a confusing merge rather than against an unfixable one.
 *
 * A gap is the weaker signal and still worth failing on: `0004` jumping to `0010` is how
 * the next person ends up looking for five files that were never written, and a gap in a
 * fresh sequence usually means a file was deleted rather than skipped on purpose.
 *
 * Both of the things already on `main` are recorded below rather than fixed. Renumbering
 * the `0003` pair is now technically safe, but it is a change to applied migrations for
 * cosmetic benefit and it belongs to whoever owns the schema, not to a CI branch. The gap
 * is history. Recording them is what lets the check be an error rather than a warning
 * nobody reads.
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

/** On `main` before this check existed. See the header for why neither is fixed here. */
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
      `ingenting annat — så om båda rör samma tabell är ordningen en slump.\n` +
      `  Numrera om den som kom sist. Det är säkert även efter en deploy: liggaren nycklar ` +
      `på innehåll också, så migrate.ts känner igen en omdöpt fil och flyttar raden i ` +
      `stället för att köra om den.`,
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
