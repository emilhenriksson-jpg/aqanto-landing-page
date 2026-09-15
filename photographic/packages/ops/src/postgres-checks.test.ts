import { describe, expect, it } from 'vitest';

import {
  deletionCheck,
  exportCheck,
  jobQueueCheck,
  migrationCheck,
  MIGRATION_ARTIFACTS,
  MIGRATIONS_WITHOUT_ARTIFACT,
} from './postgres-checks.js';
import type { Queryable } from './postgres-checks.js';

/**
 * A database that answers by pattern.
 *
 * The checks are one query each, so matching on a fragment of the SQL is enough to write
 * every case — including the ones a real Postgres cannot easily be put into, like a ledger
 * that claims a migration whose table does not exist.
 */
function fakeDb(answers: Array<[RegExp, unknown[]]>): Queryable {
  return {
    query: async <Row>(sql: string): Promise<{ rows: Row[] }> => {
      for (const [pattern, rows] of answers) {
        if (pattern.test(sql)) return { rows: rows as Row[] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

const FILES = ['0001_init.sql', '0002_trash_and_history.sql'];
const listFiles = async (): Promise<string[]> => FILES;

describe('migrationCheck', () => {
  it('passes when the files, the ledger and the schema all agree', async () => {
    const result = await migrationCheck({
      db: fakeDb([
        [/schema_migrations/, FILES.map((id) => ({ id }))],
        [/SELECT \(/, [{ m0: true, m1: true }]],
      ]),
      listFiles,
    }).run();

    expect(result.status).toBe('ok');
    expect(result.fields).toMatchObject({ files: 2, applied: 2, missing: 0 });
  });

  it('catches the restore trap: the ledger claims a migration that never ran', async () => {
    const result = await migrationCheck({
      db: fakeDb([
        [/schema_migrations/, FILES.map((id) => ({ id }))],
        [/SELECT \(/, [{ m0: true, m1: false }]],
      ]),
      listFiles,
    }).run();

    expect(result.status).toBe('failing');
    expect(result.severity).toBe('critical');
    expect(result.title).toContain('stämplade men inte körda');
    expect(result.detail).toContain('0002_trash_and_history.sql');
    // The reason this matters more than a failed migration: nothing will ever retry it.
    expect(result.detail).toContain('bara läser liggaren');
  });

  it('catches a migration that simply did not run', async () => {
    const result = await migrationCheck({
      db: fakeDb([
        [/schema_migrations/, [{ id: '0001_init.sql' }]],
        [/SELECT \(/, [{ m0: true }]],
      ]),
      listFiles,
    }).run();

    expect(result.status).toBe('failing');
    expect(result.severity).toBe('critical');
    expect(result.detail).toContain('0002_trash_and_history.sql');
  });

  it('warns, rather than panics, when the database is newer than the image', async () => {
    const result = await migrationCheck({
      db: fakeDb([
        [/schema_migrations/, [...FILES, '0016_something_newer.sql'].map((id) => ({ id }))],
        [/SELECT \(/, [{ m0: true, m1: true }]],
      ]),
      listFiles,
    }).run();

    expect(result.status).toBe('failing');
    expect(result.severity).toBe('warning');
    expect(result.detail).toContain('0016_something_newer.sql');
  });

  it('has an artifact for every migration in the repository', async () => {
    const { readdir } = await import('node:fs/promises');
    const { MIGRATIONS_DIR } = await import('@photographic/db');
    const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();

    // A migration with no artifact is invisible to the ledger check, which is how the trap
    // would come back. Failing here is the reminder to add one line -- either an artifact,
    // or an entry in `MIGRATIONS_WITHOUT_ARTIFACT` saying why there is nothing to check.
    const uncovered = files.filter(
      (file) => !MIGRATION_ARTIFACTS[file] && !MIGRATIONS_WITHOUT_ARTIFACT[file],
    );
    expect(uncovered).toEqual([]);

    // The two lists must not overlap: a migration claiming both an artifact and a reason
    // for having none is a merge that went wrong.
    expect(Object.keys(MIGRATIONS_WITHOUT_ARTIFACT).filter((f) => MIGRATION_ARTIFACTS[f])).toEqual(
      [],
    );
  });
});

describe('jobQueueCheck', () => {
  const row = (over: Record<string, string>) => [
    {
      due: '0',
      failed: '0',
      locked: '0',
      oldest_due_seconds: '0',
      oldest_lock_seconds: '0',
      ...over,
    },
  ];

  it('passes an empty queue', async () => {
    const result = await jobQueueCheck({ db: fakeDb([[/app\.job/, row({})]]) }).run();
    expect(result.status).toBe('ok');
  });

  it('alarms when the oldest waiting job is older than the threshold', async () => {
    const result = await jobQueueCheck({
      db: fakeDb([[/app\.job/, row({ due: '12', oldest_due_seconds: '1800' })]]),
      maxDueAgeMs: 15 * 60_000,
    }).run();

    expect(result.status).toBe('failing');
    expect(result.title).toContain('30 min');
  });

  it('alarms on a claim nobody will ever release, which is the crash that loses jobs', async () => {
    const result = await jobQueueCheck({
      db: fakeDb([[/app\.job/, row({ locked: '1', oldest_lock_seconds: '3600' })]]),
    }).run();

    expect(result.status).toBe('failing');
    expect(result.detail).toContain('locked_at');
  });

  it('treats a job that gave up as a warning, not a page', async () => {
    const result = await jobQueueCheck({
      db: fakeDb([[/app\.job/, row({ failed: '2' })]]),
    }).run();

    expect(result.status).toBe('failing');
    expect(result.severity).toBe('warning');
  });
});

describe('exportCheck', () => {
  it('alarms on an export that has hung', async () => {
    const result = await exportCheck({
      db: fakeDb([[/export_job/, [{ stuck: '1', oldest_seconds: '5400', failed_recently: '0' }]]]),
    }).run();

    expect(result.status).toBe('failing');
    expect(result.title).toContain('90 min');
  });

  it('passes when nothing is pending', async () => {
    const result = await exportCheck({
      db: fakeDb([[/export_job/, [{ stuck: '0', oldest_seconds: '0', failed_recently: '0' }]]]),
    }).run();

    expect(result.status).toBe('ok');
  });
});

describe('deletionCheck', () => {
  it('treats a late deletion as critical, because it is a promise to a person', async () => {
    const result = await deletionCheck({
      db: fakeDb([[/account_deletion/, [{ overdue: '1', oldest_seconds: '172800' }]]]),
    }).run();

    expect(result.status).toBe('failing');
    expect(result.severity).toBe('critical');
    expect(result.fields).toMatchObject({ overdue: 1, lateHours: 48 });
  });
});
