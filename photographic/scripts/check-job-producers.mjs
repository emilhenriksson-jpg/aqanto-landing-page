/**
 * Refuses a job handler that nothing enqueues.
 *
 * `jobs.work('expire_invites', ...)` and `jobs.work('purge_trash', ...)` are registered in
 * both composition roots and nothing anywhere calls `jobs.enqueue` with either kind, so
 * neither handler has ever run once. Both read as finished features — the handler exists,
 * it is wired, the code inside it is correct — and that is how they passed two reviews. A
 * registration is not a feature; a registration plus a producer is.
 *
 * The shape is worth naming because it is not specific to jobs: the dangerous kind of dead
 * code is the kind that looks like live code from the place a reviewer reads. Nobody scans
 * for the absence of a caller.
 *
 * Two checks, because "dead" has two useful meanings here:
 *
 *  1. **No producer anywhere.** The handler cannot run in any configuration. The two above,
 *    recorded in `job-producers-baseline.json` with a reason, so a third one fails the
 *    build that adds it.
 *  2. **A producer in one implementation and not the other.** `packages/db` and
 *    `packages/services-memory` carry the same domain rules twice, and a kind enqueued on
 *    one side only is a feature that works in tests and not in production, or the reverse.
 *    That is zero today, so it is a hard error with no baseline.
 *
 * Tests deliberately do not count as producers. A handler reachable only from a test is
 * exactly the thing being looked for.
 *
 * Usage: node scripts/check-job-producers.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = path.join(ROOT, 'scripts', 'job-producers-baseline.json');

/**
 * The two implementations of the port set. A producer belongs to whichever of these it
 * lives under, which is enough to answer check 2 because every producer in the repository
 * sits beside the root that registers the handler.
 */
const IMPLEMENTATIONS = {
  postgres: path.join('packages', 'db'),
  memory: path.join('packages', 'services-memory'),
};

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'test-counts']);

function sources(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      sources(path.join(dir, entry.name), found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/** Comment lines skipped, so a kind named in prose cannot pass for a caller. */
function code(text) {
  return text
    .split('\n')
    .map((line) => (/^\s*(\*|\/\/|\/\*)/.test(line.trim()) ? '' : line))
    .join('\n');
}

const registrations = [];
const producers = [];

for (const file of sources(ROOT)) {
  const relative = path.relative(ROOT, file);
  const text = code(readFileSync(file, 'utf8'));

  for (const match of text.matchAll(/\.work\(\s*['"]([a-z0-9_]+)['"]/g)) {
    registrations.push({ kind: match[1], file: relative });
  }

  // Two producer shapes, and missing the second one is how the first version of this
  // check reported two live handlers as dead: `services.jobs.enqueue({ ... })` is the
  // port call, and `enqueueJob(db, { ... })` is the helper `packages/db` uses so an
  // enqueue can join an open transaction. A check that only knew the first said
  // `embed_item` and `rebuild_projections` had no producer, which was wrong in the
  // direction that matters most — a green answer about dead code.
  for (const match of text.matchAll(/(?:\b[\w.]+\.)?enqueue(?:Job)?\s*\(/g)) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const line = text.slice(lineStart, text.indexOf('\n', match.index));
    // Declarations, not calls: the port interface and the two implementations.
    if (/\b(?:function|async)\s+enqueue/.test(line) || /^\s*enqueue\s*\(input/.test(line)) {
      continue;
    }

    const after = text.slice(match.index, match.index + 400);

    // A call that forwards an object it was handed rather than building one is a
    // pass-through, not a producer: `PgJobs.enqueue` is `await enqueueJob(this.pool,
    // input)`. No brace before the closing paren means no literal to read, and counting
    // it as unresolved would report a parser limitation as a finding.
    const closing = after.indexOf(')');
    const brace = after.indexOf('{');
    if (brace === -1 || (closing !== -1 && closing < brace)) continue;

    const kind = /kind:\s*['"]([a-z0-9_]+)['"]/.exec(after);
    if (kind) {
      producers.push({ kind: kind[1], file: relative });
    } else {
      // A computed kind cannot be resolved by reading the source, and guessing would make
      // this check quietly wrong in the direction that matters. Say so instead.
      producers.push({ kind: null, file: relative });
    }
  }
}

const unresolved = producers.filter((p) => p.kind === null);
const resolved = producers.filter((p) => p.kind !== null);
const implementationOf = (file) =>
  Object.entries(IMPLEMENTATIONS).find(([, dir]) => file.startsWith(dir))?.[0] ?? null;

const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
const allowed = new Map(baseline.known.map((entry) => [entry.kind, entry]));

const problems = [];
const kinds = [...new Set(registrations.map((r) => r.kind))].sort();
const dead = [];

for (const kind of kinds) {
  const produced = resolved.filter((p) => p.kind === kind);
  const registeredIn = registrations.filter((r) => r.kind === kind);

  if (produced.length === 0) {
    if (!allowed.has(kind)) {
      dead.push(
        `${kind} — registrerad i ${registeredIn.map((r) => r.file).join(', ')}, ` +
          `enqueue:as ingenstans`,
      );
    }
    continue;
  }

  // Registered by one implementation's root but produced only by the other's code.
  for (const registration of registeredIn) {
    const root = implementationOf(registration.file);
    if (!root) continue;
    const here = produced.some((p) => implementationOf(p.file) === root);
    if (!here) {
      problems.push(
        `${kind} registreras i ${registration.file} men enqueue:as bara i den andra ` +
          `implementationen (${produced.map((p) => p.file).join(', ')}).\n` +
          `  Handlern kan alltså aldrig köra i ${root}-vägen. packages/db och ` +
          `packages/services-memory bär samma domänregler två gånger, och en jobbtyp som ` +
          `bara produceras på ena sidan är en funktion som fungerar i tester och inte i ` +
          `produktion, eller tvärtom.`,
      );
    }
  }
}

if (dead.length > 0) {
  problems.push(
    `${dead.length} jobbhandler har ingen producent:\n    ${dead.join('\n    ')}\n` +
      `  En registrering läser som en färdig funktion — handlern finns, den är inkopplad, ` +
      `koden i den är riktig — och det är så den här sortens död kod passerar en ` +
      `granskning. Antingen finns anroparen som skulle ha lagt jobbet i kön, eller så ska ` +
      `registreringen bort.\n` +
      `  Hör den ändå hit just nu, lägg den i ${path.relative(ROOT, BASELINE_FILE)} med ` +
      `ett skäl. Tester räknas medvetet inte som producenter.`,
  );
}

const stale = [...allowed.keys()].filter(
  (kind) => !kinds.includes(kind) || resolved.some((p) => p.kind === kind),
);
if (stale.length > 0) {
  problems.push(
    `Föråldrade rader i baslinjen: ${stale.join(', ')}.\n` +
      `  Handlern är antingen borttagen eller har fått en producent. Ta bort raden ur ` +
      `${path.relative(ROOT, BASELINE_FILE)} — baslinjen ska bara kunna krympa.`,
  );
}

if (unresolved.length > 0) {
  problems.push(
    `enqueue-anrop där jobbtypen inte går att läsa ur källan: ` +
      `${unresolved.map((p) => p.file).join(', ')}.\n` +
      `  Den här kontrollen kan inte avgöra vad de producerar, så den skulle svara fel om ` +
      `den gissade. Skriv jobbtypen som en literal, eller utöka parsern.`,
  );
}

console.log(
  `${registrations.length} registreringar (${kinds.length} jobbtyper), ` +
    `${resolved.length} producenter. Kända döda: ${allowed.size}.`,
);

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('Varje jobbhandler har en producent, i båda implementationerna.');
