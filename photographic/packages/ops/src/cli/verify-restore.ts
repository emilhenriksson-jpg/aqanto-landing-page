/**
 * Proves — or disproves — that a restored memory is the memory.
 *
 *   # before: describe what exists, and keep the file somewhere else
 *   DATABASE_URL=<produktion, läsning> pnpm --filter @photographic/ops verify-restore -- \
 *     --out /tmp/fingerprint-before.json
 *
 *   # after restoring into a scratch target: describe it again and diff
 *   DATABASE_URL=<scratch> pnpm --filter @photographic/ops verify-restore -- \
 *     --baseline /tmp/fingerprint-before.json --out /tmp/fingerprint-after.json
 *
 * Reads only. It never writes to either database, so pointing it at production is safe —
 * which matters, because the baseline has to come from production for the comparison to
 * mean anything.
 *
 * Exit codes: 0 identical (or no baseline given), 1 differences found, 2 could not run.
 * That makes it usable as the last step of a restore procedure rather than a thing to read.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';

import { createPool, MIGRATIONS_DIR } from '@photographic/db';

import { resolveBlobStoreFromEnv } from '../blob-store.js';
import { diffFingerprints, takeFingerprint, type MemoryFingerprint } from '../fingerprint.js';
import { migrationCheck } from '../postgres-checks.js';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Host and database only. A connection string is a credential and never printed. */
function describeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return 'okänd';
  }
}

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL måste peka på databasen som ska verifieras.');
    return 2;
  }

  const storage = resolveBlobStoreFromEnv(process.env);
  const pool = createPool({ connectionString });
  const documentLimit = argument('documents');

  try {
    // Run first, and print it whatever the answer: a restored database whose ledger claims
    // migrations it never ran will produce a *matching* fingerprint and a schema that is
    // permanently wrong. That is the one failure this comparison cannot see by itself.
    const migrations = await migrationCheck({ db: pool }).run();
    console.log(JSON.stringify({ step: 'migrations', ...migrations }));

    const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();

    const started = Date.now();
    const fingerprint = await takeFingerprint({
      db: pool,
      blobs: storage.blobs,
      migrationFiles: files,
      target: {
        database: describeTarget(connectionString),
        storage: storage.target,
        storageKind: storage.kind,
      },
      ...(documentLimit ? { documentLimit: Number(documentLimit) } : {}),
    });
    const tookMs = Date.now() - started;

    console.log(
      JSON.stringify({
        step: 'fingerprint',
        tookMs,
        target: fingerprint.target,
        events: fingerprint.eventLog,
        documents: {
          documents: fingerprint.documents.documents,
          checked: fingerprint.documents.checked,
          bytes: fingerprint.documents.bytes,
          missing: fingerprint.documents.missing.length,
          corrupt: fingerprint.documents.corrupt.length,
        },
        tables: Object.fromEntries(
          Object.entries(fingerprint.tables).map(([table, value]) => [table, value.count]),
        ),
      }),
    );

    const out = argument('out');
    if (out) {
      await writeFile(out, `${JSON.stringify(fingerprint, null, 2)}\n`, 'utf8');
      console.log(JSON.stringify({ step: 'written', out }));
    }

    // A missing blob is a failure on its own terms, with or without a baseline: the row
    // says a document exists and the bytes are not there.
    let failed = fingerprint.documents.missing.length > 0 || fingerprint.documents.corrupt.length > 0;
    if (migrations.status !== 'ok') failed = true;

    const baselinePath = argument('baseline');
    if (baselinePath) {
      const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as MemoryFingerprint;
      const differences = diffFingerprints(baseline, fingerprint);
      for (const difference of differences) console.log(JSON.stringify({ step: 'diff', ...difference }));
      console.log(
        JSON.stringify({
          step: 'result',
          identical: differences.length === 0,
          differences: differences.length,
          baselineTakenAt: baseline.takenAt,
        }),
      );
      if (differences.length > 0) failed = true;
    }

    return failed ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  },
);
