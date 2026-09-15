/**
 * Puts document originals back into Storage from the off-site archive.
 *
 *   pnpm --filter @photographic/ops restore-documents -- --dry-run   # what is missing
 *   pnpm --filter @photographic/ops restore-documents                # restore what is missing
 *   pnpm --filter @photographic/ops restore-documents -- --all       # rewrite everything
 *
 * Point `SUPABASE_*` (or `BLOB_S3_*`) at the target that should receive them — a scratch
 * bucket for a drill, the real one for an incident. Restore is idempotent: the store is
 * content-addressed, so writing an object that is already there changes nothing.
 *
 * Ends by verifying, and its exit code is the verification's: 0 means every original the
 * database references is present in Storage and hashes to what the database says it is.
 */

import { createPool } from '@photographic/db';

import { resolveBlobStoreFromEnv } from '../blob-store.js';
import { createArchiveFromEnv } from '../archive.js';
import { restoreDocuments } from '../document-backup.js';
import { verifyDocuments } from '../fingerprint.js';

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL måste vara satt: databasen säger vilka original som ska finnas.');
    return 2;
  }

  const selection = createArchiveFromEnv(process.env);
  if (!selection) {
    console.error('Inget arkiv konfigurerat — det finns inget att återställa från.');
    return 2;
  }

  const destination = resolveBlobStoreFromEnv(process.env);
  const pool = createPool({ connectionString });
  const dryRun = has('dry-run');

  try {
    const result = await restoreDocuments({
      db: pool,
      archive: selection.archive,
      destination: destination.blobs,
      all: has('all'),
      dryRun,
      onProgress: (message) => {
        if (has('verbose')) console.log(JSON.stringify({ step: 'object', message }));
      },
    });

    console.log(
      JSON.stringify({
        step: 'restore',
        dryRun,
        from: `${selection.archive.kind}:${selection.archive.target}`,
        to: `${destination.kind}:${destination.target}`,
        documents: result.documents,
        intact: result.intact,
        restored: result.restored,
        megabytes: Math.round(result.bytes / 1e5) / 10,
        lost: result.lost.length,
        refused: result.refused.length,
        tookMs: result.tookMs,
      }),
    );

    for (const problem of [...result.lost, ...result.refused]) {
      console.log(JSON.stringify({ step: 'problem', filename: problem.filename, key: problem.key }));
    }

    if (dryRun) return result.lost.length > 0 || result.refused.length > 0 ? 1 : 0;

    // Not "the copy loop finished" but "the product can serve them again": every row's
    // original fetched from the destination and re-hashed.
    const verification = await verifyDocuments({ db: pool, blobs: destination.blobs });
    console.log(
      JSON.stringify({
        step: 'verify',
        documents: verification.documents,
        checked: verification.checked,
        megabytes: Math.round(verification.bytes / 1e5) / 10,
        missing: verification.missing.length,
        corrupt: verification.corrupt.length,
      }),
    );

    return verification.missing.length > 0 || verification.corrupt.length > 0 ? 1 : 0;
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
