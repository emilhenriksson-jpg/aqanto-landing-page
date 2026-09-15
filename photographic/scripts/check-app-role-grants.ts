/**
 * Asserts that every object in schema `app` is reachable by `photographic_app`.
 *
 * Production connects as `photographic_app`, a role with DML and no DDL, so that an
 * injection or a mistake in application code cannot reach `DROP TABLE app.event` or
 * `ALTER TABLE ... DISABLE TRIGGER` — which is what "the log is the truth" rests on.
 * `0016_app_role_grants.sql` sets that up and is guarded on the role existing, so on a
 * database without it the migration is a no-op that prints a notice.
 *
 * That guard is why this check has to exist. The role existed in neither CI nor local
 * development, so nothing in the pipeline could tell whether a new database object was
 * reachable by the role production actually uses. It works today only because `0016` runs
 * `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ...`, and that covers objects created by
 * the role that executed it. A later migration creating a table as any other role, or a
 * function with a stricter default, produces an object the application cannot touch — and
 * the failure arrives as a permission error on the live host, on one query, at whatever
 * hour someone first uses that feature.
 *
 * So: enumerate every table, sequence and function in `app` and ask the database directly
 * whether the role can use it. Enumerating beats running a suite, because a suite only
 * covers the objects some test happens to touch, and the objects nobody tests are exactly
 * the ones whose grants nobody notices are missing. The suite run is worth having too and
 * happens separately: `apps/rest`'s tests connect as this role in CI.
 *
 * Two negative assertions are as load-bearing as the positive ones. The role must not be
 * able to write `app.schema_migrations` — a row inserted there is a migration that will
 * never run, which is the silent-wrong-schema outcome the adoption heuristic caused — and
 * it must not have TRUNCATE, which bypasses the row triggers that hold the append-only
 * rules.
 *
 * ## Pointing it at production
 *
 * Safe, and built to be provably so rather than asserted to be. CI answers this question
 * about a database that started empty ten seconds ago; the only thing that answers it
 * about the database people's memories are actually in is a run against production.
 *
 *   AUDIT_DATABASE_URL='postgres://…' node --import tsx scripts/check-app-role-grants.ts
 *
 * Three properties that make that a reasonable thing to do:
 *
 *  - **`AUDIT_DATABASE_URL` rather than `DATABASE_URL`.** It takes precedence when set, so
 *    a live URL can be handed to this one command without repointing the variable every
 *    other tool on the machine reads. Nothing here writes, but `pnpm db:reset` next to it
 *    in the same shell does.
 *  - **Every statement runs in a `READ ONLY` transaction**, and the script asserts the
 *    session really is read-only before it queries anything. So the database refuses any
 *    write this file could attempt — today, or after an edit by someone who did not read
 *    this comment.
 *  - **No privilege of its own needed.** `has_table_privilege` and the catalogs are
 *    readable by any role that can connect, so this needs no DDL, no write and no
 *    ownership.
 *
 * On that last point, precisely, because the loose version of it was on the record for a
 * while: "it can run as `photographic_app` itself" is true only where that role exists,
 * which today is CI and a marked local database. The first production run had to use the
 * owner credential, for the same reason the run was worth making — there is no
 * `photographic_app` in production yet to connect as. The read-only transaction is what
 * made that safe, and it is the part of this design that carries the weight; the
 * connect-as-the-app-role property is a nice-to-have that arrives with the role.
 *
 * It prints the host, database and role it looked at, because an audit that might have
 * been pointed somewhere else is not an audit.
 *
 * Usage: node --import tsx scripts/check-app-role-grants.ts
 */

import { createPool } from '@photographic/db';

const ROLE = process.env.APP_ROLE ?? 'photographic_app';
const WRITABLE = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

const auditUrl = process.env.AUDIT_DATABASE_URL;
const pool = createPool(auditUrl ? { connectionString: auditUrl, max: 1 } : { max: 1 });
const problems: string[] = [];
const unreachable: string[] = [];

/**
 * One client for everything, held inside a read-only transaction. A pool would hand out
 * a fresh connection per query and the `READ ONLY` would apply to none of them.
 */
const client = await pool.connect();

try {
  await client.query('BEGIN TRANSACTION READ ONLY');

  // `current_setting`, not `SHOW transaction_read_only`: `SHOW` names its own output
  // column and takes no alias, so the first version of this read `undefined` and refused
  // to run against a session that was in fact read-only. An assertion that cannot pass is
  // no better than one that cannot fail.
  const readOnly = await client.query<{ read_only: string }>(
    `SELECT current_setting('transaction_read_only') AS read_only`,
  );
  if (readOnly.rows[0]?.read_only !== 'on') {
    throw new Error(
      'Transaktionen är inte read-only, trots BEGIN TRANSACTION READ ONLY. Avbryter ' +
        'hellre än att köra mot en databas utan den spärren — det här skriptet är tänkt ' +
        'att kunna pekas på produktion.',
    );
  }

  const where = await client.query<{ db: string; host: string | null; user: string }>(
    `SELECT current_database() AS db, inet_server_addr()::text AS host, current_user AS user`,
  );
  const at = where.rows[0];
  console.log(
    `Granskar ${ROLE} i databasen "${at?.db}" på ${at?.host ?? 'lokal socket'}, ` +
      `ansluten som ${at?.user}, i en read-only-transaktion.`,
  );

  const roleExists = await client.query<{ ok: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS ok',
    [ROLE],
  );

  /**
   * Which of two databases this is, because the fix is opposite in each and the wrong
   * half of the advice is actively harmful.
   *
   * A database built from empty has not applied the grants migration yet, so creating the
   * role and then migrating works: `0016` sees the role and grants. A database that has
   * already recorded it — production — gets nothing from that, because the ledger means
   * the migration never runs a second time. Following the first instruction there leaves
   * an application that reaches none of its objects, silently, until the first query.
   *
   * Matched on the descriptive part of the filename rather than the number, because the
   * ledger keys on content now and renumbering is routine here: four branches did it in
   * one afternoon, and `0016` may not be called that by the time someone reads this.
   */
  // Two queries, not one with a `CASE` around the subquery: Postgres resolves table names
  // when it parses, so a missing `app.schema_migrations` errors before any branch is
  // evaluated. A database that has never been migrated is exactly the case whose advice
  // is "create the role, then migrate", so it has to survive being pointed at one.
  const ledgerExists = await client.query<{ ok: boolean }>(
    `SELECT to_regclass('app.schema_migrations') IS NOT NULL AS ok`,
  );
  const appliedGrantMigrations = ledgerExists.rows[0]?.ok
    ? (
        await client.query<{ id: string }>(
          `SELECT id FROM app.schema_migrations WHERE id LIKE '%app_role%grants%' ORDER BY id`,
        )
      ).rows.map((row) => row.id)
    : [];

  // The unguarded one, which creates the role itself. `%app_role_grants%` matched only the
  // guarded `0016` and not `0020_app_role_and_grants.sql`, so this file used to advise
  // writing a migration that already exists.
  const unguarded = appliedGrantMigrations.find((id) => id.includes('app_role_and_grants'));
  const guardedOnly = !unguarded && appliedGrantMigrations.length > 0;

  /** What to do about missing grants here, which depends on the answer above. */
  const remediation = unguarded
    ? [
        `${unguarded} är applicerad. Den skapar rollen om den saknas och delar ut`,
        'rättigheterna villkorslöst, så om något ovan ändå inte går att nå är det inte ett',
        'glömt handgrepp utan ett fel: antingen har objektet skapats av en annan roll än den',
        'som migreringen kördes som, eller så har rättigheter återkallats efteråt.',
        '',
        'Kör `pnpm db:migrate` igen — grants-delen är villkorslös och körs om utan skada — och',
        'om det inte hjälper, jämför ägaren av objektet med rollen migreringen kördes som.',
      ]
    : guardedOnly
      ? [
          `${appliedGrantMigrations.join(', ')} står som applicerad i app.schema_migrations,`,
          'men det är den *vaktade* varianten: den delade bara ut rättigheter om rollen redan',
          'fanns, och eftersom ledgern noterat den körs den aldrig igen. Att bara skapa rollen',
          'delar därför inte ut någonting — den skulle nå noll av objekten i app, tyst, fram',
          'till första frågan.',
          '',
          'Den nya migreringen finns redan: `0020_app_role_and_grants.sql` skapar rollen om',
          'den saknas och delar ut rättigheterna villkorslöst. Deploya den och kör',
          '`pnpm db:migrate`. Skapa inte rollen för hand först — det behövs inte, och det är',
          'just det handgreppet som gör att någon tror att saken är avklarad.',
        ]
      : [
        'Grants-migreringen är ännu inte applicerad här, så den vanliga ordningen fungerar:',
        '',
        `  CREATE ROLE ${ROLE} LOGIN PASSWORD '<genererat>';`,
        '  pnpm db:migrate',
        '',
        'Ordningen är inte valfri: finns rollen inte när grants-migreringen körs blir den en',
        'no-op som ändå noteras som applicerad, och sedan körs den aldrig igen. Då krävs en',
        'ny migrering i stället, och det är det dyrare läget.',
        '',
        'Rollen är för övrigt en egenskap hos hela Postgres-instansen, inte hos databasen —',
        'rättigheterna är per databas. En roll som redan finns för en annan databas har',
        'alltså inga rättigheter här.',
      ];

  if (!roleExists.rows[0]?.ok) {
    console.error(
      [
        `Rollen ${ROLE} finns inte i den här databasen.`,
        '',
        'Det är precis luckan den här filen stängdes för att täcka: produktionen ansluter',
        'som den rollen, och utan den lokalt eller i CI kan ingenting säga om ett nytt',
        'databasobjekt går att nå därifrån.',
        '',
        ...remediation,
        '',
        guardedOnly
          ? 'Läget här är alltså: rollen saknas och det vaktade grants-steget är förbrukat, ' +
            'så ingenting går att nå. Det går inte att åtgärda genom att skapa rollen — det ' +
            'är migreringen ovan som gör båda delarna.'
          : `Lösenordet: trivialt duger för utveckling och CI (${ROLE}/${ROLE} är vad ` +
            'pipelinen använder). Produktionens sätts av operatören, aldrig i en fil här.',
      ].join('\n'),
    );
    process.exit(1);
  }

  // The role exists but there is nothing to reach yet. Saying so beats a
  // `schema "app" does not exist` from inside `has_schema_privilege`.
  const schemaExists = await client.query<{ ok: boolean }>(
    `SELECT to_regclass('app.person') IS NOT NULL AS ok`,
  );
  if (!schemaExists.rows[0]?.ok) {
    console.error(
      [
        'Schemat app finns inte i den här databasen, så det finns inga objekt att granska.',
        '',
        ...remediation,
      ].join('\n'),
    );
    process.exit(1);
  }

  const schema = await client.query<{ usage: boolean; create: boolean }>(
    `SELECT has_schema_privilege($1, 'app', 'USAGE')  AS usage,
            has_schema_privilege($1, 'app', 'CREATE') AS create`,
    [ROLE],
  );
  if (!schema.rows[0]?.usage) problems.push(`${ROLE} saknar USAGE på schemat app.`);
  if (schema.rows[0]?.create) {
    problems.push(
      `${ROLE} har CREATE på schemat app. Den ska inte kunna skapa objekt — hela poängen ` +
        `med rollen är att applikationskod inte kommer åt DDL.`,
    );
  }

  const tables = await client.query<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'app' ORDER BY tablename`,
  );

  for (const { name } of tables.rows) {
    const ledger = name === 'schema_migrations';
    const granted = await client.query<Record<string, boolean>>(
      `SELECT ${[...WRITABLE, 'TRUNCATE']
        .map((p) => `has_table_privilege($1, 'app.${name}', '${p}') AS "${p}"`)
        .join(', ')}`,
      [ROLE],
    );
    const row = granted.rows[0] ?? {};

    if (row.TRUNCATE) {
      problems.push(
        `${ROLE} har TRUNCATE på app.${name}. TRUNCATE går runt radtriggrarna som håller ` +
          `append-only-reglerna, och ingenting i applikationen behöver det.`,
      );
    }

    if (ledger) {
      if (!row.SELECT) problems.push(`${ROLE} saknar SELECT på app.schema_migrations.`);
      for (const write of ['INSERT', 'UPDATE', 'DELETE'] as const) {
        if (row[write]) {
          problems.push(
            `${ROLE} har ${write} på app.schema_migrations. En rad där är en migrering som ` +
              `aldrig kommer att köras.`,
          );
        }
      }
      continue;
    }

    const missing = WRITABLE.filter((p) => !row[p]);
    if (missing.length > 0) unreachable.push(`app.${name} (saknar ${missing.join(', ')})`);
  }

  // One problem listing every table rather than one problem each: the explanation is the
  // same sentence 27 times over on a database where the grants never ran at all, and a
  // wall of identical paragraphs is how a real finding gets scrolled past.
  if (unreachable.length > 0) {
    const all = unreachable.length === tables.rows.length - 1;
    problems.push(
      `${unreachable.length} tabeller går inte att nå från ${ROLE}:\n    ` +
        `${unreachable.join('\n    ')}\n` +
        `  Objekten finns men applikationen kan inte använda dem, så frågorna som rör dem ` +
        `faller i produktion och ingen annanstans.\n` +
        (all
          ? `  Det är *alla* tabeller, vilket betyder att grants-steget aldrig delade ut ` +
            `någonting — inte att en enskild migrering glömde en GRANT. Rollen skapades ` +
            `efter att grants-migreringen redan var applicerad, eller finns ännu inte.\n`
          : `  Det är några och inte alla, vilket pekar på en enskild migrering: skapades ` +
            `tabellen av en annan roll än den som körde grants-steget? ALTER DEFAULT ` +
            `PRIVILEGES täcker bara den rollens objekt, så lägg en explicit GRANT i ` +
            `migreringen som skapade den.\n`) +
        `  ${remediation.join('\n  ')}`,
    );
  }

  const sequences = await client.query<{ name: string; usage: boolean; select: boolean }>(
    `SELECT sequencename AS name,
            has_sequence_privilege($1, 'app.' || quote_ident(sequencename), 'USAGE')  AS usage,
            has_sequence_privilege($1, 'app.' || quote_ident(sequencename), 'SELECT') AS select
       FROM pg_sequences WHERE schemaname = 'app' ORDER BY sequencename`,
    [ROLE],
  );
  for (const seq of sequences.rows) {
    if (!seq.usage || !seq.select) {
      problems.push(
        `app.${seq.name} saknar ${!seq.usage ? 'USAGE' : ''}${!seq.usage && !seq.select ? ' och ' : ''}${!seq.select ? 'SELECT' : ''} för ${ROLE}. ` +
          `En sekvens utan USAGE gör varje INSERT i tabellen den räknar för omöjlig.`,
      );
    }
  }

  const functions = await client.query<{ signature: string; execute: boolean }>(
    `SELECT p.oid::regprocedure::text AS signature,
            has_function_privilege($1, p.oid, 'EXECUTE') AS execute
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' ORDER BY 1`,
    [ROLE],
  );
  for (const fn of functions.rows) {
    if (!fn.execute) {
      problems.push(
        `${fn.signature} saknar EXECUTE för ${ROLE}. Funktionerna är hur applikationen gör ` +
          `det schemat medvetet inte låter den göra direkt, så en saknad EXECUTE är en ` +
          `funktion som bara fungerar för ägaren.`,
      );
    }
  }

  console.log(
    `${ROLE}: ${tables.rows.length} tabeller, ${sequences.rows.length} sekvenser, ` +
      `${functions.rows.length} funktioner i app.`,
  );
} finally {
  // `ROLLBACK`, not `COMMIT`, and not because it matters to a read-only transaction: it
  // is the line a future reader checks when they want to know whether this file can write.
  await client.query('ROLLBACK').catch(() => {});
  client.release();
  await pool.end();
}

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log('Varje objekt i app går att nå från applikationsrollen.');
