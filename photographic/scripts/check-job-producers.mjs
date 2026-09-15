/**
 * Refuses a job handler that nothing enqueues.
 *
 * `jobs.work('expire_invites', ...)` and `jobs.work('purge_trash', ...)` were registered
 * in both composition roots with nothing anywhere calling `jobs.enqueue` for either kind,
 * so neither handler had ever run once. Both read as finished features — the handler
 * exists, it is wired, the code inside it is correct — and that is how they passed two
 * reviews. A registration is not a feature; a registration plus a producer is.
 *
 * PR #23 closed both in the Postgres root by seeding them through `scheduleRecurring`, and
 * this check is what keeps that true and what found the same shape twice more the same
 * day: `purge_documents` and `reconcile_storage` arrived registered and unproduced, and
 * the in-memory root still schedules nothing at all.
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
const computed = [];

for (const file of sources(ROOT)) {
  const relative = path.relative(ROOT, file);
  const text = code(readFileSync(file, 'utf8'));

  for (const match of text.matchAll(/\.work\(\s*['"]([a-z0-9_]+)['"]/g)) {
    registrations.push({ kind: match[1], file: relative });
  }

  // Producers are found by looking for the *kind*, not for the call shape. Three
  // versions of this check tried to recognise the call and all three were wrong in the
  // same direction — a confident "this handler is dead" about a handler that was not:
  //
  //   `.enqueue({ kind: 'x' })`            the port call
  //   `enqueueJob(db, { kind: 'x' })`      the helper packages/db uses so an enqueue can
  //                                        join an open transaction
  //   `scheduleRecurring([{ kind: 'x' }])` the seeding added when these handlers were
  //                                        found dead; the kind reaches `enqueue` as a
  //                                        variable, so no call-shape parser sees it
  //
  // So: any `kind: '<literal>'` outside a `.work(` registration counts as producing that
  // kind. It matches against the registered kinds only, so the many unrelated `kind:`
  // discriminators in this codebase ('personal', 'shared', 'document') can never collide
  // with a job kind by accident. Broad on purpose: the cost of a false "alive" is a
  // handler nobody deleted, and the cost of a false "dead" is a build failure that tells
  // a person something untrue about their own code.
  for (const match of text.matchAll(/kind:\s*['"]([a-z0-9_]+)['"]/g)) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const line = text.slice(lineStart, text.indexOf('\n', match.index) + 1 || undefined);
    if (line.includes('.work(')) continue;
    producers.push({ kind: match[1], file: relative });
  }

  // A kind that only ever arrives as a variable cannot be read out of the source at all.
  // Not a failure — `scheduleRecurring` legitimately does this — but it is the reason a
  // "no producer" verdict below carries a caveat rather than a full stop.
  for (const match of text.matchAll(/kind:\s*(?!['"])([A-Za-z_$][\w.$]*)/g)) {
    const before = text.slice(Math.max(0, match.index - 300), match.index);
    if (/enqueue|schedule/i.test(before)) computed.push({ file: relative, via: match[1] });
  }
}

const resolved = producers;
const implementationOf = (file) =>
  Object.entries(IMPLEMENTATIONS).find(([, dir]) => file.startsWith(dir))?.[0] ?? null;

const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
/**
 * Two exemption shapes, keyed the same way the two checks are. `kind` alone means no
 * producer anywhere; `kind` plus `root` means registered by that implementation's root and
 * produced only by the other one's.
 */
const key = (kind, root) => (root ? `${kind}@${root}` : kind);
const allowed = new Map(baseline.known.map((entry) => [key(entry.kind, entry.root), entry]));
const used = new Set();

const problems = [];
const kinds = [...new Set(registrations.map((r) => r.kind))].sort();
const dead = [];

for (const kind of kinds) {
  const produced = resolved.filter((p) => p.kind === kind);
  const registeredIn = registrations.filter((r) => r.kind === kind);

  if (produced.length === 0) {
    if (allowed.has(key(kind, null))) {
      used.add(key(kind, null));
    } else {
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
    if (produced.some((p) => implementationOf(p.file) === root)) continue;

    if (allowed.has(key(kind, root))) {
      used.add(key(kind, root));
      continue;
    }
    problems.push(
      `${kind} registreras i ${registration.file} men enqueue:as bara i den andra ` +
        `implementationen (${[...new Set(produced.map((p) => p.file))].join(', ')}).\n` +
        `  Handlern kan alltså aldrig köra i ${root}-vägen. packages/db och ` +
        `packages/services-memory bär samma domänregler två gånger, och en jobbtyp som ` +
        `bara produceras på ena sidan är en funktion som fungerar i ena vägen och inte i ` +
        `den andra.\n  Hör den ändå hit just nu, lägg den i ` +
        `${path.relative(ROOT, BASELINE_FILE)} med "root": "${root}" och ett skäl.`,
    );
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
      `ett skäl. Tester räknas medvetet inte som producenter.` +
      (computed.length > 0
        ? `\n  Notera: ${computed.length} enqueue-anrop får jobbtypen som en variabel ` +
          `(${[...new Set(computed.map((c) => c.file))].join(', ')}). Om någon av dem ` +
          `producerar den här typen ser den här kontrollen det inte — läs den innan du ` +
          `raderar en handler.`
        : ''),
  );
}

const stale = [...allowed.keys()].filter((k) => !used.has(k));
if (stale.length > 0) {
  problems.push(
    `Föråldrade rader i baslinjen: ${stale.join(', ')}.\n` +
      `  Handlern är antingen borttagen eller har fått en producent. Ta bort raden ur ` +
      `${path.relative(ROOT, BASELINE_FILE)} — baslinjen ska bara kunna krympa.`,
  );
}

// Only producers of a kind something actually registers: the literal scan sees every
// `kind:` discriminator in the repository, and reporting that total would be a number
// nobody can check.
const relevant = resolved.filter((p) => kinds.includes(p.kind)).length;
console.log(
  `${registrations.length} registreringar (${kinds.length} jobbtyper), ` +
    `${relevant} producenter${computed.length > 0 ? ` (+${computed.length} via variabel)` : ''}. ` +
    `Kända döda: ${allowed.size}.`,
);

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('Varje jobbhandler har en producent, i båda implementationerna.');
