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
 *  - **No owner needed.** `has_table_privilege` and the catalogs are readable by any role,
 *    so this can run as a read-only monitoring role, or as `photographic_app` itself. It
 *    never needs the credential that could do damage.
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

  if (!roleExists.rows[0]?.ok) {
    console.error(
      [
        `Rollen ${ROLE} finns inte i den här databasen.`,
        '',
        'Det är precis luckan den här filen stängdes för att täcka: produktionen ansluter',
        'som den rollen, och utan den lokalt eller i CI kan ingenting säga om ett nytt',
        'databasobjekt går att nå därifrån. Skapa den en gång:',
        '',
        `  CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}';`,
        '',
        'Kör sedan om migreringarna, för 0016 delar bara ut rättigheter när rollen finns.',
        'Lösenordet ovan är avsiktligt trivialt: det gäller en utvecklings- eller',
        'CI-databas. Produktionens sätts av operatören, se scripts/deploy.md.',
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
    problems.push(
      `${unreachable.length} tabeller går inte att nå från ${ROLE}:\n    ` +
        `${unreachable.join('\n    ')}\n` +
        `  Objekten finns men applikationen kan inte använda dem, så frågorna som rör dem ` +
        `faller i produktion och ingen annanstans.\n` +
        `  Två vanliga orsaker. Skapades tabellen av en annan roll än den som körde 0016? ` +
        `ALTER DEFAULT PRIVILEGES täcker bara den rollens objekt, så lägg en explicit GRANT ` +
        `i migreringen som skapade den.\n` +
        `  Eller skapades rollen efter att 0016 redan var applicerad? Då var 0016 en no-op ` +
        `och körs aldrig igen, för liggaren har den. Kör grants-blocket ur 0016 för hand en ` +
        `gång — sekvensen står i scripts/deploy.md.`,
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
