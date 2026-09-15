/**
 * The checks that read the database.
 *
 * All four are one query each and none of them writes, so the watchdog can run them every
 * minute against the same Postgres that serves requests without being something you have
 * to think about. They take a `Queryable` rather than a `Pool` so a test can answer them
 * without a database, and so the caller decides whether they share the app's pool or open
 * their own.
 */

import { readdir } from 'node:fs/promises';

import { MIGRATIONS_DIR } from '@photographic/db';

import type { Check, CheckResult } from './alert.js';
import { failing, ok } from './alert.js';

export interface Queryable {
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * One checkable artifact per migration.
 *
 * This list is the answer to the one failure mode that can make a schema *permanently*
 * wrong without anything erroring: `migrate.ts` stamps every migration file as applied
 * when the ledger is empty and `app.person` exists. A database in that state reports a
 * complete ledger and has whatever schema it actually had — and since the ledger is the
 * only thing the runner consults, nothing will ever run the missing migrations. It is
 * reachable from a restore, which is exactly when nobody is in a position to notice.
 *
 * So the ledger is not trusted on its own. Each row is checked against something the
 * migration really created. A migration with no entry here is invisible to this check;
 * when you add a migration, add its most load-bearing object. The expressions are
 * catalogue lookups rather than `SELECT`s against the tables, so they cost nothing and
 * cannot fail on a permission the app does not have.
 */
export const MIGRATION_ARTIFACTS: Record<string, string> = {
  '0001_init.sql': `to_regclass('app.person') IS NOT NULL`,
  '0002_trash_and_history.sql': fn('purge_expired_items'),
  '0003_provenance_and_authorship.sql': fn('reject_implicit_shared_placement'),
  '0003_swedish_search.sql': index('item_fts_idx'),
  '0004_calendar_and_trash_views.sql': `to_regclass('app.trash') IS NOT NULL`,
  '0010_documents_and_storage.sql': `to_regclass('app.storage_object') IS NOT NULL`,
  '0011_oauth_persistence.sql': `to_regclass('app.oauth_token') IS NOT NULL`,
  '0012_chunk_compound_search.sql': index('chunk_text_trgm_idx'),
  '0013_export_and_deletion.sql': `to_regclass('app.export_job') IS NOT NULL`,
  '0014_permit_personal_room_erasure.sql': fn('erase_personal_room'),
  '0015_personal_compass.sql': column('profile', 'compass'),
};

function fn(name: string): string {
  return `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = '${name}')`;
}

function index(name: string): string {
  return `EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'app' AND indexname = '${name}')`;
}

function column(table: string, name: string): string {
  return `EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = '${table}' AND column_name = '${name}')`;
}

export interface MigrationCheckOptions {
  db: Queryable;
  /** Where the migration files are. Defaults to the ones this image shipped with. */
  dir?: string;
  /** Injected in tests. */
  listFiles?: (dir: string) => Promise<string[]>;
}

/**
 * Compares three things that are supposed to agree: the migration files in this image,
 * the rows in `app.schema_migrations`, and the objects actually present in the database.
 *
 * Every way they can disagree is a real failure with a different cause:
 *
 * - **A file with no ledger row** — the boot migration did not run or did not finish.
 *   `Dockerfile` chains it with `;` rather than `&&`, so a failed migration still starts
 *   the server against a half-applied schema, and the health check says nothing.
 * - **A ledger row whose object is missing** — the adoption branch stamped a migration
 *   nobody ran. This is the restore trap, and it is the only one that stays wrong forever.
 * - **A ledger row with no file** — the image is older than the database, i.e. a rollback
 *   deployed over a newer schema. Only a warning: it is usually deliberate and usually
 *   harmless, but it explains errors that otherwise make no sense.
 */
export function migrationCheck(options: MigrationCheckOptions): Check {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const listFiles =
    options.listFiles ??
    (async (target: string) => (await readdir(target)).filter((name) => name.endsWith('.sql')).sort());

  return {
    key: 'migrations',
    run: async (): Promise<CheckResult> => {
      const files = await listFiles(dir);
      const { rows } = await options.db.query<{ id: string }>(
        'SELECT id FROM app.schema_migrations ORDER BY id',
      );
      const applied = new Set(rows.map((row) => row.id));

      const missing = files.filter((file) => !applied.has(file));
      const unknown = [...applied].filter((id) => !files.includes(id));

      // Only the ledger's own claims are verified. A file that was never claimed is
      // already reported above, and probing it would say the same thing twice.
      const claimed = files.filter((file) => applied.has(file) && MIGRATION_ARTIFACTS[file]);
      const lying: string[] = [];
      if (claimed.length > 0) {
        const selects = claimed.map(
          (file, i) => `(${MIGRATION_ARTIFACTS[file]}) AS m${i}`,
        );
        const { rows: probe } = await options.db.query<Record<string, boolean>>(
          `SELECT ${selects.join(', ')}`,
        );
        const present = probe[0] ?? {};
        claimed.forEach((file, i) => {
          if (present[`m${i}`] !== true) lying.push(file);
        });
      }

      const fields = {
        files: files.length,
        applied: applied.size,
        missing: missing.length,
        unverified: lying.length,
        unknown: unknown.length,
      };

      if (lying.length > 0) {
        return failing({
          key: 'migrations',
          severity: 'critical',
          title: `Migrationsliggaren stämmer inte: ${lying.length} migrering(ar) är stämplade men inte körda`,
          detail:
            `Liggaren säger att ${lying[0]} är applicerad, men det den skapar finns inte i ` +
            'databasen. Schemat är fel och migreringsköraren kommer aldrig att rätta det, ' +
            'eftersom den bara läser liggaren. Vanligaste orsaken: en återställd databas ' +
            'som fick tom liggare och blev helstämplad vid boot. Kör de saknade filerna ' +
            'manuellt och rätta liggaren innan något mer skrivs.',
          fields,
        });
      }

      if (missing.length > 0) {
        return failing({
          key: 'migrations',
          severity: 'critical',
          title: `${missing.length} migrering(ar) har inte körts — schemat är halvt`,
          detail:
            `Först i kön: ${missing[0]}. Servern kan svara ändå, så det syns inte utifrån. ` +
            'Kör pnpm db:migrate mot samma DATABASE_URL och läs felet.',
          fields,
        });
      }

      if (unknown.length > 0) {
        return failing({
          key: 'migrations',
          severity: 'warning',
          title: `Databasen har ${unknown.length} migrering(ar) som den här versionen inte känner`,
          detail:
            `Nyast okänd: ${unknown[unknown.length - 1]}. Avbilden är äldre än databasen, ` +
            'vilket normalt betyder en tillbakarullad deploy.',
          fields,
        });
      }

      return ok({
        key: 'migrations',
        severity: 'critical',
        title: 'Schemat är à jour och liggaren stämmer med verkligheten',
        fields,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The job queue
// ---------------------------------------------------------------------------

export interface JobQueueCheckOptions {
  db: Queryable;
  /** How old the oldest waiting job may be. Default 15 minutes. */
  maxDueAgeMs?: number;
  /**
   * How long a claim may be held. Default 15 minutes.
   *
   * `claimDue` sets `locked_at` and nothing ever clears it, so a process that dies
   * mid-job leaves that job invisible to every later pass — permanently. Until a lease
   * exists, an old claim is the only sign, and it is worth an alarm precisely because the
   * queue looks empty afterwards.
   */
  maxLockAgeMs?: number;
}

interface JobQueueRow {
  due: string;
  failed: string;
  locked: string;
  oldest_due_seconds: string;
  oldest_lock_seconds: string;
}

/**
 * Is the queue draining?
 *
 * Everything that keeps the memory current runs through `app.job`: embeddings, profile and
 * brief rebuilds, document summaries, room headlines. When it stops, nothing errors and no
 * screen goes red — the product simply stops keeping up with the person, and the only
 * symptom is a search that does not find something written an hour ago.
 */
export function jobQueueCheck(options: JobQueueCheckOptions): Check {
  const maxDueAgeMs = options.maxDueAgeMs ?? 15 * 60 * 1000;
  const maxLockAgeMs = options.maxLockAgeMs ?? 15 * 60 * 1000;

  return {
    key: 'job_queue',
    run: async (): Promise<CheckResult> => {
      const { rows } = await options.db.query<JobQueueRow>(`
        SELECT
          count(*) FILTER (WHERE locked_at IS NULL AND failed_at IS NULL AND run_after <= now()) AS due,
          count(*) FILTER (WHERE failed_at IS NOT NULL) AS failed,
          count(*) FILTER (WHERE locked_at IS NOT NULL) AS locked,
          coalesce(max(extract(epoch FROM (now() - run_after)))
            FILTER (WHERE locked_at IS NULL AND failed_at IS NULL AND run_after <= now()), 0)
            AS oldest_due_seconds,
          coalesce(max(extract(epoch FROM (now() - locked_at)))
            FILTER (WHERE locked_at IS NOT NULL), 0) AS oldest_lock_seconds
        FROM app.job
      `);

      const row = rows[0];
      const due = Number(row?.due ?? 0);
      const failedJobs = Number(row?.failed ?? 0);
      const locked = Number(row?.locked ?? 0);
      const oldestDueMs = Number(row?.oldest_due_seconds ?? 0) * 1000;
      const oldestLockMs = Number(row?.oldest_lock_seconds ?? 0) * 1000;

      const fields = {
        due,
        failed: failedJobs,
        locked,
        oldestDueMinutes: minutes(oldestDueMs),
        oldestLockMinutes: minutes(oldestLockMs),
      };

      if (oldestDueMs > maxDueAgeMs) {
        return failing({
          key: 'job_queue',
          severity: 'critical',
          title: `Jobbkön töms inte — äldsta jobbet har väntat ${minutes(oldestDueMs)} min`,
          detail:
            'Embeddings, profiler och sammanfattningar slutar följa personen medan detta ' +
            'pågår, utan att något syns i produkten. Kontrollera att processen lever och ' +
            'läs job_failed i loggen.',
          fields,
        });
      }

      if (oldestLockMs > maxLockAgeMs) {
        return failing({
          key: 'job_queue',
          severity: 'critical',
          title: `Ett jobb har varit claimat i ${minutes(oldestLockMs)} min — troligen efter en krasch`,
          detail:
            'Ett claim släpps aldrig av sig självt, så jobbet är osynligt för varje senare ' +
            'körning. Nollställ locked_at på raden när du vet att ingen process kör den.',
          fields,
        });
      }

      if (failedJobs > 0) {
        return failing({
          key: 'job_queue',
          severity: 'warning',
          title: `${failedJobs} jobb har gett upp efter alla försök`,
          detail: 'Läs last_error i app.job. Raden ligger kvar och körs inte igen.',
          fields,
        });
      }

      return ok({ key: 'job_queue', severity: 'critical', title: 'Jobbkön töms', fields });
    },
  };
}

// ---------------------------------------------------------------------------
// Exports and deletions: the two promises with a deadline
// ---------------------------------------------------------------------------

export interface AccountJobsCheckOptions {
  db: Queryable;
  /** How long an export may be pending or running. Default 30 minutes. */
  maxExportMs?: number;
  /** How late a due deletion may be. Default 24 hours. */
  maxDeletionLateMs?: number;
}

interface ExportRow {
  stuck: string;
  oldest_seconds: string;
  failed_recently: string;
}

/**
 * An export that never finishes, and a deletion that never happens.
 *
 * Both are moved to `running`/`requested` and neither has a recovery path: a process that
 * dies mid-export leaves the row `running` forever, and the sweep swallows every failure
 * per item. From the person's side, an export is a page that says "pågår" indefinitely and
 * a deletion is a promise that silently was not kept on the day they were told — the
 * second one is the more serious of the two, and the one nobody would ever discover.
 */
export function exportCheck(options: AccountJobsCheckOptions): Check {
  const maxExportMs = options.maxExportMs ?? 30 * 60 * 1000;

  return {
    key: 'exports',
    run: async (): Promise<CheckResult> => {
      const { rows } = await options.db.query<ExportRow>(
        `SELECT
           count(*) FILTER (WHERE status IN ('pending', 'running')
             AND requested_at < now() - ($1::double precision * interval '1 millisecond')) AS stuck,
           coalesce(max(extract(epoch FROM (now() - requested_at)))
             FILTER (WHERE status IN ('pending', 'running')), 0) AS oldest_seconds,
           count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '24 hours')
             AS failed_recently
         FROM app.export_job`,
        [maxExportMs],
      );

      const row = rows[0];
      const stuck = Number(row?.stuck ?? 0);
      const failedRecently = Number(row?.failed_recently ?? 0);
      const oldestMs = Number(row?.oldest_seconds ?? 0) * 1000;
      const fields = { stuck, failedRecently, oldestMinutes: minutes(oldestMs) };

      if (stuck > 0) {
        return failing({
          key: 'exports',
          severity: 'warning',
          title: `${stuck} export har hängt i ${minutes(oldestMs)} min`,
          detail:
            'En export som fastnat i running kommer aldrig att plockas upp igen — den ' +
            'personen ser "pågår" för alltid. Sätt raden till failed så att den kan begäras ' +
            'om, och läs export_crashed i loggen.',
          fields,
        });
      }

      if (failedRecently > 0) {
        return failing({
          key: 'exports',
          severity: 'warning',
          title: `${failedRecently} export har misslyckats det senaste dygnet`,
          detail: 'Läs error-kolumnen i app.export_job. Exporten är löftet att kunna lämna oss.',
          fields,
        });
      }

      return ok({ key: 'exports', severity: 'warning', title: 'Inga exporter har hängt', fields });
    },
  };
}

export function deletionCheck(options: AccountJobsCheckOptions): Check {
  const maxDeletionLateMs = options.maxDeletionLateMs ?? 24 * 60 * 60 * 1000;

  return {
    key: 'deletions',
    run: async (): Promise<CheckResult> => {
      const { rows } = await options.db.query<{ overdue: string; oldest_seconds: string }>(
        `SELECT count(*) AS overdue,
                coalesce(max(extract(epoch FROM (now() - execute_after))), 0) AS oldest_seconds
         FROM app.account_deletion
         WHERE status = 'requested'
           AND execute_after < now() - ($1::double precision * interval '1 millisecond')`,
        [maxDeletionLateMs],
      );

      const row = rows[0];
      const overdue = Number(row?.overdue ?? 0);
      const oldestMs = Number(row?.oldest_seconds ?? 0) * 1000;
      const fields = { overdue, lateHours: Math.round(oldestMs / 3_600_000) };

      if (overdue > 0) {
        return failing({
          key: 'deletions',
          severity: 'critical',
          title: `${overdue} kontoradering är ${fields.lateHours} h försenad`,
          detail:
            'Personen fick ett datum och det har passerat. Läs account_deletion_failed i ' +
            'loggen; sveppet loggar och sväljer felet per post.',
          fields,
        });
      }

      return ok({
        key: 'deletions',
        severity: 'critical',
        title: 'Inga förfallna kontoraderingar',
        fields,
      });
    },
  };
}

/** Every database-backed check, with the defaults. */
export function postgresChecks(db: Queryable): Check[] {
  return [migrationCheck({ db }), jobQueueCheck({ db }), exportCheck({ db }), deletionCheck({ db })];
}
