/**
 * Refuses a new test double in the production import graph.
 *
 * This check exists because of one bug. `apps/rest/src/wiring.ts` imports
 * `MemorySessionIssuer` and `MemoryCodeStore` from `@photographic/connect/testing`, and
 * the first of those is what authenticated real people on the live deploy: a session
 * token was verified by pattern-matching a person id out of a string, so any member of a
 * shared room could sign in as any other member. It was not a subtle bug. It shipped and
 * stayed there because nothing read the import graph and nothing ran on a pull request.
 *
 * So: walk the graph from the processes that actually run in production, and report every
 * module that pulls in a package's `/testing` entry point. The known ones are recorded in
 * `test-doubles-baseline.json` with a reason, which makes two things true at once — the
 * debt is visible in a file a person can read, and a *new* double fails the build on the
 * pull request that introduces it, which is the only moment it is cheap to argue about.
 *
 * The baseline is a ratchet, not a mute button. An entry that no longer matches anything
 * also fails, with the line to delete, so the list can only shrink.
 *
 * No dependencies on purpose: this has to run before `pnpm install` finishes, and a
 * guard nobody can run locally without a toolchain is a guard people route around.
 *
 * Usage: node scripts/check-test-doubles.mjs
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = path.join(ROOT, 'scripts', 'test-doubles-baseline.json');

/**
 * What production runs. `server.ts` is the Dockerfile's `CMD`, and `migrate.ts` is the
 * other thing that process starts with — it holds a connection to real memory, so a fake
 * reaching it matters as much as one reaching a route.
 *
 * The browser bundles are deliberately not here yet: `apps/web` has its own version of
 * this problem (`isDemoMode()` defaults to fixtures) and it wants a different check than
 * "does it import from testing", so pretending this one covers it would be worse than
 * leaving it out and saying so.
 */
const ENTRY_POINTS = ['apps/rest/src/server.ts', 'packages/db/src/migrate.ts'];

const workspacePackages = new Map();
for (const group of ['packages', 'apps']) {
  const dir = path.join(ROOT, group);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSafe(dir)) {
    const manifestPath = path.join(dir, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name) {
      workspacePackages.set(manifest.name, {
        dir: path.join(dir, entry),
        exports: manifest.exports ?? {},
      });
    }
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Import specifiers, skipping comment lines so a doc comment cannot fail the build. */
function importsIn(source) {
  const found = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;
    // Covers `from '…'` on its own line (multi-line imports land there), a bare
    // `import '…'`, and `await import('…')`.
    for (const match of line.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) found.push(match[1]);
    for (const match of line.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) found.push(match[1]);
    for (const match of line.matchAll(/^import\s*['"]([^'"]+)['"]/g)) found.push(match[1]);
  }
  return found;
}

function resolveFile(candidate) {
  // Relative imports carry `.js` because of `verbatimModuleSyntax`; the file is `.ts`.
  const attempts = [
    candidate.replace(/\.js$/, '.ts'),
    candidate.replace(/\.js$/, '.tsx'),
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    path.join(candidate, 'index.ts'),
    path.join(candidate, 'index.tsx'),
  ];
  for (const attempt of attempts) {
    if (existsSync(attempt) && statSync(attempt).isFile()) return attempt;
  }
  return null;
}

/** Returns the file a specifier resolves to, or null for anything outside the workspace. */
function resolve(specifier, fromFile) {
  if (specifier.startsWith('.')) {
    return resolveFile(path.resolve(path.dirname(fromFile), specifier));
  }

  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const pkg = workspacePackages.get(name);
  if (!pkg) return null;

  const subpath = specifier === name ? '.' : `./${parts.slice(name.split('/').length).join('/')}`;
  const target = pkg.exports[subpath];
  if (typeof target !== 'string') return null;
  return resolveFile(path.resolve(pkg.dir, target));
}

const violations = [];
const seen = new Set();
const queue = [];

for (const entry of ENTRY_POINTS) {
  const file = path.join(ROOT, entry);
  if (!existsSync(file)) {
    console.error(`Ingångspunkten ${entry} finns inte. Uppdatera ENTRY_POINTS.`);
    process.exit(2);
  }
  queue.push(file);
}

while (queue.length > 0) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);

  const importer = path.relative(ROOT, file);
  for (const specifier of importsIn(readFileSync(file, 'utf8'))) {
    const resolved = resolve(specifier, file);
    if (!resolved) continue;

    const relative = path.relative(ROOT, resolved);
    const isDouble = specifier.endsWith('/testing') || /(^|\/)src\/testing\//.test(relative);
    if (isDouble) {
      violations.push({ importer, specifier });
      // Not followed: what a double imports is its own business.
      continue;
    }
    queue.push(resolved);
  }
}

const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
const key = (v) => `${v.importer} -> ${v.specifier}`;
const allowed = new Map(baseline.known.map((entry) => [key(entry), entry]));

const unexpected = violations.filter((v) => !allowed.has(key(v)));
const stale = [...allowed.keys()].filter((k) => !violations.some((v) => key(v) === k));

console.log(`Läste ${seen.size} moduler från ${ENTRY_POINTS.length} ingångspunkter.`);
console.log(
  `Hittade ${violations.length} testdubbletter, varav ${violations.length - unexpected.length} kända.`,
);

if (unexpected.length > 0) {
  console.error('\nNy testdubblett i produktionsgrafen:\n');
  for (const v of unexpected) console.error(`  ${v.importer}\n    importerar ${v.specifier}`);
  console.error(
    [
      '',
      'Ett `*/testing`-modul i den här grafen körs i produktion. Senaste gången det',
      'hände autentiserade den riktiga människor (MemorySessionIssuer i wiring.ts), och',
      'ingenting märkte det på tre veckor.',
      '',
      'Antingen: skriv den riktiga implementationen.',
      `Eller: om den hör dit ändå, lägg den i ${path.relative(ROOT, BASELINE_FILE)} med`,
      'ett skäl som håller för en granskare. Listan finns för att vara läsbar, inte tyst.',
    ].join('\n'),
  );
}

if (stale.length > 0) {
  console.error('\nFöråldrade rader i baslinjen — importen finns inte längre:\n');
  for (const k of stale) console.error(`  ${k}`);
  console.error(
    `\nTa bort dem ur ${path.relative(ROOT, BASELINE_FILE)}. Baslinjen ska bara kunna krympa.`,
  );
}

if (unexpected.length > 0 || stale.length > 0) process.exit(1);
console.log('Inga nya testdubbletter.');
