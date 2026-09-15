/**
 * Refuses a GitHub Actions workflow in a directory GitHub does not read.
 *
 * Actions only registers workflows in `.github/workflows/` at the *repository root*. A
 * workflow anywhere else is a file: it parses, it reviews well, it never runs, and nothing
 * says so. There is no error, no skipped run, no entry in the Actions tab — the absence is
 * the whole symptom.
 *
 * This repository has one. `photographic/.github/workflows/document-archive.yml` is the
 * off-site copy of every uploaded document, on a daily and a weekly schedule, and the
 * workspace it belongs to is a subdirectory rather than the root. The GitHub API lists two
 * registered workflows for this repository and it is not one of them, so it has never
 * executed once. Its own header is the reason that stings: "the failure mode this is built
 * against is not 'the copy is wrong' but 'nobody noticed it stopped'" — and it never
 * started. A dead-man's switch that was never wound cannot fire.
 *
 * The same shape as every other check in this directory, which is why it is worth having
 * rather than fixing the one file and moving on: a registration that reads as a working
 * feature from the place a reviewer reads it.
 *
 * Usage: node scripts/check-workflow-locations.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The repository root, which is the parent of the workspace: see `AGENTS.md`. */
const REPO = path.resolve(WORKSPACE, '..');
const BASELINE_FILE = path.join(WORKSPACE, 'scripts', 'dead-workflows-baseline.json');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'test-counts']);

function workflowFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      workflowFiles(path.join(dir, entry.name), found);
    } else if (/\.ya?ml$/.test(entry.name) && dir.endsWith(path.join('.github', 'workflows'))) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

const LIVE = path.join(REPO, '.github', 'workflows');
const baseline = existsSync(BASELINE_FILE)
  ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
  : { known: [] };
const allowed = new Map(baseline.known.map((entry) => [entry.path, entry]));

const found = workflowFiles(REPO);
const dead = [];
const seen = new Set();

for (const file of found) {
  const relative = path.relative(REPO, file);
  if (path.dirname(file) === LIVE) continue;
  if (allowed.has(relative)) {
    seen.add(relative);
    continue;
  }
  dead.push(relative);
}

const problems = [];

if (dead.length > 0) {
  problems.push(
    `${dead.length} workflow-filer ligger där GitHub inte läser dem:\n    ` +
      `${dead.join('\n    ')}\n` +
      `  Actions registrerar bara .github/workflows/ i repots rot. En fil någon annanstans ` +
      `parsas aldrig, körs aldrig och syns inte i Actions-fliken — frånvaron är hela ` +
      `symptomet.\n  Flytta den till ${path.relative(REPO, LIVE)}/ och kontrollera att ` +
      `dess secrets finns innan den börjar köra, eller lägg den i ` +
      `${path.relative(WORKSPACE, BASELINE_FILE)} med ett skäl.`,
  );
}

const stale = [...allowed.keys()].filter((p) => !seen.has(p));
if (stale.length > 0) {
  problems.push(
    `Föråldrade rader i baslinjen: ${stale.join(', ')}.\n` +
      `  Filen är flyttad eller borttagen. Ta bort raden — baslinjen ska bara kunna krympa.`,
  );
}

console.log(
  `${found.length} workflow-filer, ${found.length - dead.length - allowed.size} i rotens ` +
    `.github/workflows. Kända döda: ${allowed.size}.`,
);

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('Varje workflow ligger där GitHub läser den.');
