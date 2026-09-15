/**
 * Runs the test suites, and says out loud which ones it could not run.
 *
 * `pnpm test` used to be `pnpm -r run test`, which walks the workspace in topological
 * order and aborts on the first failure. On a machine with no local Postgres that meant
 * `packages/db` failed 38 tests with ECONNREFUSED, pnpm stopped there, and `apps/rest`,
 * `apps/web`, `apps/onboarding`, `apps/mcp` and `e2e` never ran at all — from the one
 * command a new developer types. It failed loudly, which was right, but it failed loudly
 * about the wrong thing and hid five suites behind the noise.
 *
 * So this runner does three things instead:
 *
 *   1. Groups the suites by what they need, and runs every group even when an earlier
 *      one fails. You get the whole picture from one run, not the first quarter of it.
 *   2. Probes for a database before running the groups that need one, and if there is
 *      none, names the suites it skipped and prints the commands that get you a database.
 *   3. Exits non-zero when anything failed *or* was skipped. A run that could not test
 *      the SQL is not a green run, and this is the file that refuses to pretend otherwise.
 *
 * The groups are also the unit CI splits on (`.github/workflows/ci.yml` calls this file
 * with a group name), so the definition of "the unit suites" lives in one place and
 * cannot drift between a laptop and a pull request.
 *
 * Usage:
 *   node scripts/run-suites.mjs                 all groups
 *   node scripts/run-suites.mjs unit            one or more groups by name
 *   node scripts/run-suites.mjs --list          print the group names
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_DATABASE_URL = 'postgres://photographic:photographic@127.0.0.1:5432/photographic';
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

/**
 * `--filter '!x'` rather than a list of the packages that do not need a database: a new
 * package then joins the default group without anyone remembering to add it, and the
 * failure mode of forgetting is "it runs somewhere it should not" rather than "nothing
 * ever runs it". The second is the one that hides.
 *
 * `!photographic` excludes the workspace root, whose own `test` script is this file —
 * without it the run recurses into itself.
 */
const GROUPS = [
  {
    name: 'unit',
    what: 'every package that does not touch Postgres (includes apps/web, apps/onboarding, apps/mcp)',
    needsDatabase: false,
    argv: [
      '-r',
      "--filter=!photographic",
      '--filter=!@photographic/db',
      '--filter=!@photographic/rest',
      '--filter=!@photographic/e2e',
      'run',
      'test',
    ],
  },
  {
    name: 'e2e-memory',
    what: 'the acceptance suite on the in-memory reference implementation',
    needsDatabase: false,
    env: { HARNESS: 'memory' },
    argv: ['--filter=@photographic/e2e', 'run', 'test'],
  },
  {
    name: 'db',
    what: 'packages/db and apps/rest against Postgres',
    needsDatabase: true,
    // One database, so one package at a time: both reset the schema, and in parallel one
    // suite's reset pulls the schema out from under the other. Same reason the old root
    // script passed `--workspace-concurrency=1`.
    //
    // `db:migrate` first because `apps/rest`'s suite does not create the schema itself.
    // Run after `packages/db` it inherits one and passes; run alone against an empty
    // database it fails 12 tests in `connect-flow.test.ts` with errors that look like
    // application bugs. That ordering dependency is invisible until it bites.
    migrateFirst: true,
    argv: [
      '--workspace-concurrency=1',
      '--filter=@photographic/db',
      '--filter=@photographic/rest',
      'run',
      'test',
    ],
  },
  {
    name: 'e2e-postgres',
    what: 'the acceptance suite against the real schema, triggers and transactions',
    needsDatabase: true,
    env: { HARNESS: 'postgres' },
    argv: ['--filter=@photographic/e2e', 'run', 'test'],
  },
];

/** A TCP connect, not a query: this file must not depend on `pg` being installed. */
function databaseReachable(url, timeoutMs = 2000) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = net.connect({
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
    });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function run(argv, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', argv, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl, ...env },
    });
    child.once('error', (error) => {
      console.error(`Kunde inte starta pnpm: ${error.message}`);
      resolve(1);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

function missingDatabaseHelp() {
  return [
    '',
    `Ingen Postgres svarar på ${databaseUrl}.`,
    '',
    'Sviterna ovan som behöver en databas kördes inte. Det går att fixa på en minut —',
    'schemat behöver pgvector utöver contrib-tilläggen (pgcrypto, pg_trgm, citext,',
    'unaccent), så vilken Postgres som helst duger inte:',
    '',
    '  docker run -d --name photographic-pg -p 5432:5432 \\',
    '    -e POSTGRES_USER=photographic -e POSTGRES_PASSWORD=photographic \\',
    '    -e POSTGRES_DB=photographic pgvector/pgvector:pg16',
    '',
    'Eller på Debian/Ubuntu:  sudo apt install postgresql-16 postgresql-16-pgvector',
    'Eller på macOS:          brew install postgresql@16 pgvector',
    '',
    'Peka någon annanstans med DATABASE_URL. Migreringarna körs åt dig; de skapar sina',
    'egna tillägg och e2e-sviten skapar sin egen databas (`..._e2e`) och migrerar om den',
    'per körning.',
    '',
    'Bara de databasfria sviterna:  pnpm test:unit && pnpm test:e2e:memory',
    '(Det är inte samma sak som en grön körning. SQL:et — triggrarna, transaktionerna,',
    'villkoren — är otestat utan en databas.)',
  ].join('\n');
}

const args = process.argv.slice(2);

if (args.includes('--list')) {
  for (const group of GROUPS) console.log(group.name);
  process.exit(0);
}

const unknown = args.filter((arg) => !GROUPS.some((group) => group.name === arg));
if (unknown.length > 0) {
  console.error(`Okänd svit: ${unknown.join(', ')}`);
  console.error(`Välj bland: ${GROUPS.map((g) => g.name).join(', ')}`);
  process.exit(2);
}

const selected = args.length > 0 ? GROUPS.filter((g) => args.includes(g.name)) : GROUPS;
const needsDatabase = selected.some((group) => group.needsDatabase);
const haveDatabase = needsDatabase ? await databaseReachable(databaseUrl) : false;

const results = [];
let migrated = false;

for (const group of selected) {
  if (group.needsDatabase && !haveDatabase) {
    results.push({ group, status: 'skipped' });
    continue;
  }

  if (group.migrateFirst && !migrated) {
    console.log(`\n--- db:migrate (${databaseUrl.replace(/:[^:@/]*@/, ':***@')})\n`);
    const code = await run(['run', 'db:migrate']);
    if (code !== 0) {
      results.push({ group, status: 'failed' });
      continue;
    }
    migrated = true;
  }

  console.log(`\n--- ${group.name}: ${group.what}\n`);
  const code = await run(group.argv, group.env);
  results.push({ group, status: code === 0 ? 'passed' : 'failed' });
}

const label = { passed: 'OK     ', failed: 'MISSLYCKADES', skipped: 'HOPPADES ÖVER' };
console.log('\n=== Sammanfattning ===');
for (const { group, status } of results) {
  console.log(`${label[status].padEnd(14)} ${group.name.padEnd(13)} ${group.what}`);
}

const failed = results.filter((r) => r.status === 'failed');
const skipped = results.filter((r) => r.status === 'skipped');

if (skipped.length > 0) console.log(missingDatabaseHelp());

if (failed.length > 0 || skipped.length > 0) process.exit(1);
console.log('\nAllt grönt, inget överhoppat.');
