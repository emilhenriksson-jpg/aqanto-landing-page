/**
 * Refuses a job handler that nothing enqueues.
 *
 * A `jobs.work('some_kind', ...)` registration reads as a finished feature — the handler
 * exists, it is wired, the code inside it is correct — and that is exactly how
 * `expire_invites` and `purge_trash` passed review: registered in both composition roots,
 * enqueued by nothing, so neither handler had ever run. A registration is not a feature;
 * a registration plus a producer is.
 *
 * The shape is worth naming because it is not specific to jobs: the dangerous kind of dead
 * code is the kind that looks like live code from the place a reviewer reads. Nobody scans
 * for the absence of a caller.
 *
 * Two checks, because "dead" has two useful meanings here:
 *
 *  1. **No producer anywhere.** The handler cannot run in any configuration. Recorded in
 *     `job-producers-baseline.json` with a reason, so a *new* one fails the build.
 *  2. **A producer in one implementation and not the other.** `packages/db` and
 *     `packages/services-memory` carry the same domain rules twice, and a kind enqueued on
 *     one side only is a feature that works in tests and not in production, or the
 *     reverse. That is zero today, so it is a hard error with no baseline.
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
        `${kind} — registered in ${registeredIn.map((r) => r.file).join(', ')}, ` +
          `enqueued nowhere`,
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
        `${kind} is registered in ${registration.file} but only enqueued from the other ` +
          `implementation (${produced.map((p) => p.file).join(', ')}).\n` +
          `  The handler can therefore never run on the ${root} path. packages/db and ` +
          `packages/services-memory carry the same domain rules twice, and a job kind ` +
          `produced on only one side is a feature that works in tests and not in ` +
          `production, or the reverse.`,
      );
    }
  }
}

if (dead.length > 0) {
  problems.push(
    `${dead.length} job handler(s) have no producer:\n    ${dead.join('\n    ')}\n` +
      `  A registration reads as a finished feature — the handler exists, it is wired, ` +
      `the code inside it is correct — and that is how this kind of dead code passes a ` +
      `review. Either the caller that should have enqueued it is missing, or the ` +
      `registration should go.\n` +
      `  If it genuinely belongs here for now, add it to ` +
      `${path.relative(ROOT, BASELINE_FILE)} with a reason. Tests deliberately do not ` +
      `count as producers.`,
  );
}

const stale = [...allowed.keys()].filter(
  (kind) => !kinds.includes(kind) || resolved.some((p) => p.kind === kind),
);
if (stale.length > 0) {
  problems.push(
    `Stale baseline entries: ${stale.join(', ')}.\n` +
      `  The handler was either removed or has gained a producer. Delete the row from ` +
      `${path.relative(ROOT, BASELINE_FILE)} — the baseline can only shrink.`,
  );
}

if (unresolved.length > 0) {
  problems.push(
    `Enqueue call(s) whose job kind cannot be read from the source: ` +
      `${unresolved.map((p) => p.file).join(', ')}.\n` +
      `  This check cannot tell what they produce, so guessing would make it quietly ` +
      `wrong. Write the kind as a literal, or extend the parser.`,
  );
}

console.log(
  `${registrations.length} registration(s) (${kinds.length} kind(s)), ` +
    `${resolved.length} producer(s). Baselined as dead: ${allowed.size}.`,
);

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('Every job handler has a producer, in both implementations.');
