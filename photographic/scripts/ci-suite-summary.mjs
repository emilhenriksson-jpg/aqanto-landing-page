/**
 * Collects what every CI job counted and shows it in one place.
 *
 * Each test job writes `.ci-reports/<group>.json` through `run-suites.mjs` and uploads
 * it; the gate job downloads them all and runs this. Two things it can see that no
 * single job can:
 *
 *   1. A group whose report never arrived. A job that died before counting, or was
 *      dropped from the workflow by an edit, is otherwise indistinguishable from a job
 *      that passed — `needs.<job>.result` reads `skipped`, and a skipped job in a green
 *      run is exactly the shape of CI that lies.
 *   2. The skip count for every group side by side, which is the number that separates
 *      "the acceptance suite ran" from "the acceptance suite reported 62 skipped
 *      because its harness could not be built".
 *
 * Usage: node scripts/ci-suite-summary.mjs <directory-of-reports>
 */

import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectations = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts', 'suite-expectations.json'), 'utf8'),
);

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error(`Ingen rapportkatalog på ${dir ?? '(inget argument)'}.`);
  process.exit(2);
}

const reports = new Map();
for (const file of readdirSync(dir)) {
  if (!file.endsWith('.json')) continue;
  const report = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  reports.set(report.group, report);
}

const rows = [];
const problems = [];

for (const [name, expected] of Object.entries(expectations.groups)) {
  const report = reports.get(name);
  if (!report) {
    rows.push([name, '—', '—', '—', 'RAPPORT SAKNAS']);
    problems.push(
      `${name} lämnade ingen rapport. Antingen kom jobbet aldrig till testerna, eller så ` +
        `körs gruppen inte längre i .github/workflows/ci.yml. Ett jobb som inte kördes är ` +
        `inte ett jobb som gick igenom.`,
    );
    continue;
  }

  rows.push([
    name,
    String(report.passed),
    String(report.skipped),
    String(report.failed),
    report.status === 'passed' ? 'OK' : 'MISSLYCKADES',
  ]);

  if (report.status !== 'passed') {
    problems.push(`${name}: ${report.problems?.join(' ') || 'sviten misslyckades.'}`);
  }
  if (report.skipped > expected.maxSkipped) {
    problems.push(`${name}: ${report.skipped} överhoppade, taket är ${expected.maxSkipped}.`);
  }
}

const unexpected = [...reports.keys()].filter((name) => !expectations.groups[name]);
for (const name of unexpected) {
  problems.push(`Rapport för okänd grupp ${name}. Lägg den i scripts/suite-expectations.json.`);
}

const header = ['grupp', 'godkända', 'överhoppade', 'misslyckade', 'status'];
const table = [
  `| ${header.join(' | ')} |`,
  `|${header.map(() => '---').join('|')}|`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
].join('\n');

console.log(table);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Testantal per grupp\n\n${table}\n\n` +
      `Golv och tak: \`scripts/suite-expectations.json\`.\n`,
  );
}

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
