/**
 * Copies every document original to the off-site archive. Meant to be run by a schedule,
 * not by a person remembering.
 *
 *   pnpm --filter @photographic/ops backup-documents
 *   pnpm --filter @photographic/ops backup-documents -- --dry-run
 *   pnpm --filter @photographic/ops backup-documents -- --verify   # re-hash the whole archive
 *
 * Incremental: an object already in the archive is not sent again, so the second run is
 * cheap and the hundredth is too.
 *
 * Exit codes: 0 fine, 1 something is wrong with the memory (a lost original, a hash that
 * does not match), 2 the backup could not run at all. The distinction matters for whatever
 * runs this on a timer — 2 means "the copy did not happen", which is the one that must page
 * someone, and both are non-zero so neither can be mistaken for success.
 */

import { createPool } from '@photographic/db';

import { resolveBlobStoreFromEnv } from '../blob-store.js';
import { archiveBlobStore, createArchiveFromEnv } from '../archive.js';
import { backupDocuments } from '../document-backup.js';
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
    console.error(
      'Inget arkiv konfigurerat. Sätt DOCUMENT_ARCHIVE_S3_BASE_URL (+ nycklar) hos en annan ' +
        'leverantör än Supabase, eller DOCUMENT_ARCHIVE_DIR för en övning.',
    );
    return 2;
  }

  const source = resolveBlobStoreFromEnv(process.env);
  const pool = createPool({ connectionString });

  try {
    const result = await backupDocuments({
      db: pool,
      source: source.blobs,
      archive: selection.archive,
      dryRun: has('dry-run'),
      onProgress: (message) => {
        if (has('verbose')) console.log(JSON.stringify({ step: 'object', message }));
      },
    });

    console.log(
      JSON.stringify({
        step: 'backup',
        dryRun: result.dryRun,
        from: `${source.kind}:${source.target}`,
        to: `${selection.archive.kind}:${selection.archive.target}`,
        documents: result.documents,
        objects: result.objects,
        copiedThisRun: result.copiedThisRun,
        megabytes: Math.round(result.bytes / 1e5) / 10,
        lost: result.lost.length,
        recoverable: result.recoverable.length,
        mismatched: result.mismatched.length,
        tookMs: result.tookMs,
      }),
    );

    for (const problem of [...result.lost, ...result.mismatched, ...result.recoverable]) {
      console.log(JSON.stringify({ step: 'problem', filename: problem.filename, key: problem.key }));
    }

    let failed = result.lost.length > 0 || result.mismatched.length > 0;

    if (has('verify')) {
      // The whole archive, re-fetched and re-hashed against what the database says. The same
      // instrument the database restore is verified with, pointed at the backup.
      const verification = await verifyDocuments({
        db: pool,
        blobs: archiveBlobStore(selection.archive),
      });
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
      if (verification.missing.length > 0 || verification.corrupt.length > 0) failed = true;
    }

    // The dead-man's switch for the schedule itself. Pinged only on a clean run, so a job
    // that runs and fails is indistinguishable from a job that stopped — which is correct:
    // both mean there is no fresh copy.
    const heartbeat = process.env.BACKUP_HEARTBEAT_URL?.trim();
    if (heartbeat && !failed && !result.dryRun) {
      const response = await fetch(heartbeat, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      }).catch((error: unknown) => {
        console.error(`Pulsen kunde inte skickas: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      console.log(JSON.stringify({ step: 'heartbeat', status: response?.status ?? null }));
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
