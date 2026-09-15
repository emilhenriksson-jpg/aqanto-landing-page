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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTATIONS_FILE = path.join(ROOT, 'scripts', 'suite-expectations.json');
const REPORT_DIR = path.join(ROOT, 'test-counts');

const DEFAULT_DATABASE_URL = 'postgres://photographic:photographic@127.0.0.1:5432/photographic';
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

/**
 * The same database as the owner URL, reached as `photographic_app`. Derived rather than
 * configured so there is one place to point at a database and the least-privilege run
 * cannot silently end up somewhere else; `APP_DATABASE_URL` overrides it for a setup
 * where the role has a different name or password.
 */
const appRoleUrl =
  process.env.APP_DATABASE_URL ??
  (() => {
    try {
      const url = new URL(databaseUrl);
      url.username = 'photographic_app';
      url.password = 'photographic_app';
      return url.toString();
    } catch {
      return databaseUrl;
    }
  })();

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
    what: 'packages/db against Postgres, as the owner',
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
    // Migrations on disk against migrations in the ledger, in order. Everyone has been
    // verifying this by hand all day by watching the filenames scroll past.
    preflight: [['exec', 'node', '--import', 'tsx', 'scripts/check-migration-ledger.ts']],
    argv: ['--filter=@photographic/db', 'run', 'test'],
  },
  {
    // `apps/rest` connected as `photographic_app` rather than as the owner, which is how
    // production connects and how nothing has ever been tested.
    //
    // The role existed in neither CI nor local development, so nothing could tell whether
    // a new database object was reachable from it. It works today only because
    // `0016_app_role_grants.sql` runs `ALTER DEFAULT PRIVILEGES`, which covers objects
    // created by the role that executed it — so a migration creating a table as any other
    // role produces an object the application cannot touch, and the failure arrives as a
    // permission error on the live host, on one query, at whatever hour someone first uses
    // that feature. `0017` was never checked against the role at all.
    //
    // This is the one suite that can run in that configuration: `apps/rest`'s tests do no
    // DDL, where `packages/db` and `e2e` both `reset()` the schema and need the owner.
    // The preflight is the exhaustive half — every table, sequence and function in `app`,
    // not only the ones some test happens to touch — and it prints the `CREATE ROLE` line
    // when the role is missing, which is why it runs before the suite rather than after.
    name: 'rest',
    what: 'apps/rest against Postgres, as the least-privilege role production uses',
    needsDatabase: true,
    migrateFirst: true,
    preflight: [['exec', 'node', '--import', 'tsx', 'scripts/check-app-role-grants.ts']],
    asAppRole: true,
    argv: ['--filter=@photographic/rest', 'run', 'test'],
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

function run(argv, env = {}, { capture = false, asAppRole = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', argv, {
      cwd: ROOT,
      stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: asAppRole ? appRoleUrl : databaseUrl,
        ...env,
      },
    });

    let output = '';
    if (capture) {
      // Still streamed to the console: a run you cannot watch is a run people stop
      // watching. The copy is only there to count what happened.
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          output += chunk;
          process.stdout.write(chunk);
        });
      }
    }

    child.once('error', (error) => {
      console.error(`Kunde inte starta pnpm: ${error.message}`);
      resolve({ code: 1, output });
    });
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

const ANSI = /\u001B\[[0-9;]*m/g;

/**
 * Reads the test counts back out of the run.
 *
 * Counting matters as much as the exit code, and `journey.test.ts` is why. When its
 * `beforeAll` cannot reach a database, vitest reports `3 failed` files and
 * `62 skipped` tests — so a suite that stopped running and a suite that ran are one
 * word apart in the summary a person actually reads. The exit code separates them
 * today, but only because the hook throws; one `try`/`catch` in the wrong place and
 * there is nothing left but the numbers. So the numbers are checked.
 *
 * Parsed from stdout rather than `--reporter=json`, because the `unit` group is a
 * recursive run over 19 packages and vitest resolves `--outputFile` per package: every
 * one of them would write the same path. A format change breaks this parser, which is
 * why zero parsed suites is a hard failure below rather than a zero.
 */
function countsFrom(output) {
  const clean = output.replace(ANSI, '');
  const totals = { suites: 0, passed: 0, failed: 0, skipped: 0, files: 0 };

  // vitest: `Tests  104 passed | 2 skipped (106)` / `Tests  96 passed (96)`. A recursive
  // run prefixes every line with the package (`packages/core test: Tests  96 passed`),
  // so the prefix comes off first — without that the `unit` group counts zero, which is
  // how I found out this parser needed a test of its own.
  for (const raw of clean.split('\n')) {
    const line = raw.replace(/^\S+\s+\w+:\s*/, '');
    const tests = /^\s*Tests\s+(.+?)\s*$/.exec(line);
    if (tests) {
      totals.suites += 1;
      for (const [, n, kind] of tests[1].matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) {
        if (kind in totals) totals[kind] += Number(n);
      }
      continue;
    }
    const files = /^\s*Test Files\s+(.+?)\s*$/.exec(line);
    if (files) {
      for (const [, n] of files[1].matchAll(/(\d+)\s+(?:passed|failed|skipped)/g)) {
        totals.files += Number(n);
      }
      continue;
    }
    // node:test TAP, which `packages/design-tokens` uses instead of vitest.
    const tap = /^#\s+(pass|fail|skipped)\s+(\d+)\s*$/.exec(line);
    if (tap) {
      const kind = tap[1] === 'pass' ? 'passed' : tap[1] === 'fail' ? 'failed' : 'skipped';
      totals[kind] += Number(tap[2]);
      if (kind === 'passed') totals.suites += 1;
    }
  }

  return totals;
}

const expectations = JSON.parse(readFileSync(EXPECTATIONS_FILE, 'utf8'));

/**
 * The ratchet, same shape as `test-doubles-baseline.json`: adding tests raises the
 * actual above the floor and passes; a suite that quietly stops running drops below it
 * and fails. Lowering a floor is then a deliberate line in a diff.
 */
/**
 * A test gated on `OPENAI_API_KEY` runs on a machine that has one and skips on a machine
 * that does not, so a flat floor cannot be right in both places. Twice in one evening a
 * key-gated test landed and moved numbers CI could not reproduce locally — the second
 * time it left `main` red, which is worse than a wrong number because a permanently red
 * trunk hides the next real regression behind a benign one.
 *
 * So `minPassed`/`maxSkipped` are the **keyless** figures, which is what CI sees, and
 * `openAiGated` says how many tests in the group swap sides when a key is present. A
 * machine with a key then has to pass that many more and skip that many fewer, which
 * makes a local run assert more rather than less.
 */
function bounds(expected) {
  const gated = expected.openAiGated ?? 0;
  const keyed = Boolean(process.env.OPENAI_API_KEY) && gated > 0;
  return {
    keyed,
    gated,
    minPassed: expected.minPassed + (keyed ? gated : 0),
    maxSkipped: expected.maxSkipped - (keyed ? gated : 0),
  };
}

function checkCounts(group, counts) {
  const expected = expectations.groups[group.name];
  const problems = [];

  if (!expected) {
    problems.push(`${group.name} saknas i ${path.relative(ROOT, EXPECTATIONS_FILE)}.`);
    return problems;
  }

  const limits = bounds(expected);
  const mode = limits.gated
    ? ` (${limits.keyed ? 'med' : 'utan'} OPENAI_API_KEY: ${limits.gated} test byter sida)`
    : '';
  if (counts.suites === 0) {
    problems.push(
      `Kunde inte läsa några testantal ur utdatan för ${group.name}. Antingen körde inget, ` +
        `eller så har vitests sammanfattningsformat ändrats och countsFrom() i ` +
        `scripts/run-suites.mjs måste uppdateras. Det här är medvetet ett fel och inte en nolla.`,
    );
  }
  if (counts.passed < limits.minPassed) {
    problems.push(
      `${group.name}: ${counts.passed} godkända tester, golvet är ${limits.minPassed}${mode}. ` +
        `En svit har slutat köras. Sänk golvet i ${path.relative(ROOT, EXPECTATIONS_FILE)} ` +
        `bara om du menar att testerna skulle bort.`,
    );
  }
  if (counts.skipped > limits.maxSkipped) {
    problems.push(
      `${group.name}: ${counts.skipped} överhoppade tester, taket är ${limits.maxSkipped}${mode}` +
        `${expected.whySkipped ? ` (${expected.whySkipped})` : ''}. ` +
        `Ett överhoppat test är ett test ingen kör. Är det nytt och nyckelberoende, ` +
        `räkna upp openAiGated i stället för att höja taket — då gäller siffran båda ` +
        `maskinerna.`,
    );
  }

  return problems;
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
    'Två saker den databasen behöver utöver att finnas, och båda sviterna säger till med',
    'exakt kommando om de saknas:',
    '',
    '  pnpm db:mark-test    -- fyra sviter i packages/db släpper hela schemat app, så',
    '                          reset() vägrar en databas ingen har pekat ut som slask.',
    '                          Märk en slaskdatabas, inte den du arbetar i.',
    "  CREATE ROLE photographic_app LOGIN PASSWORD 'photographic_app';",
    '                       -- rollen produktionen ansluter som. `pnpm test:rest` kör',
    '                          apps/rest som den, och kontrollerar att varje objekt i',
    '                          app går att nå därifrån. Skapa den före migreringarna:',
    '                          0016 delar bara ut rättigheter när rollen finns, och',
    '                          liggaren gör att den aldrig körs igen.',
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
    const { code } = await run(['run', 'db:migrate']);
    if (code !== 0) {
      results.push({ group, status: 'failed' });
      continue;
    }
    migrated = true;
  }

  // Preflights run as the owner even when the suite does not, because they are checks
  // *about* the database rather than uses of it, and they have to be able to read the
  // catalogs and the ledger.
  let preflightFailed = false;
  for (const argv of group.preflight ?? []) {
    const { code } = await run(argv, group.env);
    if (code !== 0) preflightFailed = true;
  }
  if (preflightFailed) {
    results.push({ group, status: 'failed', problems: [] });
    continue;
  }

  console.log(`\n--- ${group.name}: ${group.what}\n`);
  const { code, output } = await run(group.argv, group.env, {
    capture: true,
    asAppRole: group.asAppRole ?? false,
  });
  const counts = countsFrom(output);
  const problems = checkCounts(group, counts);

  results.push({
    group,
    counts,
    problems,
    status: code === 0 && problems.length === 0 ? 'passed' : 'failed',
  });
}

// Written for the CI gate job to collect, so one place can show what every job counted.
// A missing file there means a job did not get as far as counting.
//
// `test-counts/` rather than `.ci-reports/`: `actions/upload-artifact` silently excludes
// dotfiles and dot-directories unless `include-hidden-files` is set, so the first version
// of this uploaded nothing and every job failed on `if-no-files-found: error`. A visible
// directory is a better answer than a flag someone has to know about.
if (results.some((r) => r.counts)) {
  mkdirSync(REPORT_DIR, { recursive: true });
  for (const { group, counts, status, problems } of results) {
    if (!counts) continue;
    writeFileSync(
      path.join(REPORT_DIR, `${group.name}.json`),
      `${JSON.stringify({ group: group.name, status, ...counts, problems }, null, 2)}\n`,
    );
  }
}

const label = { passed: 'OK', failed: 'MISSLYCKADES', skipped: 'HOPPADES ÖVER' };
console.log('\n=== Sammanfattning ===');
console.log(`${''.padEnd(14)} ${'grupp'.padEnd(13)} ${'godkända'.padEnd(9)} överhoppade`);
for (const { group, status, counts } of results) {
  const numbers = counts ? `${String(counts.passed).padEnd(9)} ${counts.skipped}` : '-';
  console.log(`${label[status].padEnd(14)} ${group.name.padEnd(13)} ${numbers}`);
}

const failed = results.filter((r) => r.status === 'failed');
const skipped = results.filter((r) => r.status === 'skipped');

for (const { problems } of results) {
  for (const problem of problems ?? []) console.error(`\n${problem}`);
}

if (skipped.length > 0) console.log(missingDatabaseHelp());

if (failed.length > 0 || skipped.length > 0) process.exit(1);
console.log('\nAllt grönt, inget överhoppat.');
