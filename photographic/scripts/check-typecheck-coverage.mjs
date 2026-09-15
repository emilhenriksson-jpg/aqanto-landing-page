/**
 * Refuses a TypeScript file that no `tsc` invocation reaches.
 *
 * `scripts/break-glass-signin.ts` had never been typechecked. It belonged to no tsconfig,
 * and the root `typecheck` is `pnpm -r run typecheck` — per workspace package — so
 * `scripts/` was skipped for the structural reason that it is not a package. The one file
 * whose job is getting a locked-out person back into their account was the least checked
 * file in the repository, and it took a linter existing before anyone noticed.
 *
 * It has a project now. This check is about the pattern rather than that file: any
 * directory that is not a workspace package is invisible to `pnpm -r`, so the next such
 * file is unchecked by default and nothing says so. Two ways that happens, and this looks
 * for both:
 *
 *  1. A `.ts` file with no tsconfig above it at all.
 *  2. A `.ts` file whose nearest tsconfig belongs to no workspace package and is named in
 *     no root script — a project that exists and that nothing ever runs, which reads as
 *     covered and is not.
 *
 * Not a substitute for `tsc --listFiles`, which would be exact and costs a second full
 * compile. This is the structural question, which is the one that has actually gone wrong.
 *
 * Usage: node scripts/check-typecheck-coverage.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'test-counts']);

/**
 * Build configuration, which `tsc` legitimately does not compile and `eslint.config.js`
 * also ignores for the same reason. Anything added here is a deliberate line in a diff;
 * the point of the check is that silence is not the default.
 */
const NOT_SOURCE = [
  /(^|\/)vitest\.config\.ts$/,
  /(^|\/)vitest\..*\.config\.ts$/,
  /(^|\/)vite\.config\.ts$/,
  /(^|\/)vitest\.shared\.ts$/,
];

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), found);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/** Workspace packages, which `pnpm -r run typecheck` reaches — if they define the script. */
const packages = new Map();
for (const group of ['packages', 'apps']) {
  const dir = path.join(ROOT, group);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir)) {
    const manifest = path.join(dir, entry, 'package.json');
    if (existsSync(manifest)) packages.set(path.join(dir, entry), manifest);
  }
}
if (existsSync(path.join(ROOT, 'e2e', 'package.json'))) {
  packages.set(path.join(ROOT, 'e2e'), path.join(ROOT, 'e2e', 'package.json'));
}

const rootScripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
const allRootScripts = Object.values(rootScripts).join(' ; ');

/** The tsconfig that governs a file: the nearest one at or above it. */
function projectFor(file) {
  let dir = path.dirname(file);
  while (dir.startsWith(ROOT)) {
    if (existsSync(path.join(dir, 'tsconfig.json'))) return dir;
    if (dir === ROOT) break;
    dir = path.dirname(dir);
  }
  return null;
}

const unprojected = [];
const unrun = new Map();

for (const file of walk(ROOT)) {
  const relative = path.relative(ROOT, file);
  if (NOT_SOURCE.some((pattern) => pattern.test(relative))) continue;

  const project = projectFor(file);
  if (!project) {
    unprojected.push(relative);
    continue;
  }

  if (packages.has(project)) {
    const manifest = JSON.parse(readFileSync(packages.get(project), 'utf8'));
    if (manifest.scripts?.typecheck) continue;
    const name = path.relative(ROOT, project);
    unrun.set(name, [
      ...(unrun.get(name) ?? []),
      relative,
    ]);
    continue;
  }

  // A tsconfig outside every workspace package. `pnpm -r` cannot see it, so the only
  // thing that can run it is a root script naming it explicitly.
  const relativeProject = path.relative(ROOT, project) || '.';
  const invoked =
    allRootScripts.includes(`tsc -p ${relativeProject}/tsconfig.json`) ||
    allRootScripts.includes(`tsc -p ${relativeProject}`) ||
    allRootScripts.includes(`tsc --project ${relativeProject}/tsconfig.json`);
  if (!invoked) {
    unrun.set(relativeProject, [...(unrun.get(relativeProject) ?? []), relative]);
  }
}

const problems = [];

if (unprojected.length > 0) {
  problems.push(
    `${unprojected.length} TypeScript-filer har ingen tsconfig ovanför sig:\n    ` +
      `${unprojected.join('\n    ')}\n` +
      `  De typkontrolleras inte, och type-aware ESLint kan inte ens parsa dem. Lägg en ` +
      `tsconfig.json i katalogen och kör den ur rot-skriptet \`typecheck\`, så som ` +
      `scripts/tsconfig.json görs.`,
  );
}

for (const [project, files] of unrun) {
  problems.push(
    `${project}/tsconfig.json körs inte av någonting:\n    ${files.join('\n    ')}\n` +
      `  Katalogen är inget workspace-paket, så \`pnpm -r run typecheck\` når den inte, och ` +
      `rot-skriptet nämner den inte. En tsconfig som inget kör läser som täckning och är ` +
      `det inte — det var precis hur scripts/break-glass-signin.ts kunde vara den minst ` +
      `kontrollerade filen i repot.\n` +
      `  Lägg \`&& tsc -p ${project}/tsconfig.json\` i \`typecheck\`.`,
  );
}

const total = walk(ROOT).filter((f) => !NOT_SOURCE.some((p) => p.test(path.relative(ROOT, f))));
console.log(`${total.length} TypeScript-filer, ${packages.size} workspace-paket.`);

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('Varje TypeScript-fil ligger i ett projekt som någonting kör.');
