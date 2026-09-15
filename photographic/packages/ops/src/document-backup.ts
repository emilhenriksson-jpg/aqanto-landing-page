/**
 * Copying the document originals somewhere else, putting them back, and noticing when the
 * copying stopped.
 *
 * The database is the source of truth for *what must exist*, not the bucket: `app.document`
 * is what the product will try to serve, so a backup driven by the rows cannot silently omit
 * a file the product still references. Listing the bucket instead would archive whatever
 * happens to be there, which is a different and much weaker claim.
 *
 * Everything is verified against its own name on the way through. The keys are
 * `sha256/<ab>/<cd>/<hash>` and the hash is of the bytes, so a file that came back changed
 * lands under a different key and is reported rather than accepted. That is also why a
 * mismatched object is **not** copied: archiving corruption under the name of the original
 * would turn a detectable problem into a permanent one.
 */

import { createHash } from 'node:crypto';

import type { BlobStore } from '@photographic/documents';

import type { Check, CheckResult } from './alert.js';
import { failing, ok } from './alert.js';
import { MANIFEST_KEY, type ObjectArchive } from './archive.js';
import type { Queryable } from './postgres-checks.js';

export interface DocumentReference {
  key: string;
  filename: string;
  byteSize: number;
  checksum: string;
}

export interface ArchiveManifest {
  takenAt: string;
  /** Rows in `app.document` when the run started. */
  documents: number;
  /** Distinct storage keys, which is fewer when two people uploaded the same file. */
  objects: number;
  bytes: number;
  copiedThisRun: number;
  /** Digest over every expected `key:byteSize`, sorted. An audit record of the set. */
  expectedDigest: string;
  /** Rows whose original is not in Storage any more but *is* in the archive. Restorable. */
  recoverable: DocumentReference[];
  /** Rows whose original is in neither place. Gone. */
  lost: DocumentReference[];
  /** Objects whose bytes did not hash to their own key. Never copied. */
  mismatched: DocumentReference[];
  /** Where the originals were read from, without credentials. */
  source: string;
  archive: string;
}

export interface BackupResult extends ArchiveManifest {
  tookMs: number;
  dryRun: boolean;
}

const KEY_QUERY = `
  SELECT DISTINCT ON (d.storage_key)
         d.storage_key, d.filename, d.byte_size::text AS byte_size, d.checksum
  FROM app.document d
  ORDER BY d.storage_key, d.created_at
`;

async function references(db: Queryable): Promise<DocumentReference[]> {
  const { rows } = await db.query<{
    storage_key: string;
    filename: string;
    byte_size: string;
    checksum: string;
  }>(KEY_QUERY);
  return rows.map((row) => ({
    key: row.storage_key,
    filename: row.filename,
    byteSize: Number(row.byte_size),
    checksum: row.checksum,
  }));
}

function digestOf(items: DocumentReference[]): string {
  const lines = items
    .map((item) => `${item.key}:${item.byteSize}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

/** Capped so a manifest stays small enough to fetch on every check. */
const PROBLEM_CAP = 50;

export interface BackupOptions {
  db: Queryable;
  /** Where the originals live now — the product's own `BlobStore`. */
  source: BlobStore;
  archive: ObjectArchive;
  /** Report what would happen without writing anything. */
  dryRun?: boolean;
  now?: () => Date;
  onProgress?: (message: string) => void;
}

export async function backupDocuments(options: BackupOptions): Promise<BackupResult> {
  const now = options.now ?? (() => new Date());
  const progress = options.onProgress ?? (() => {});
  const started = Date.now();

  const expected = await references(options.db);
  const { rows: counted } = await options.db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM app.document',
  );

  const manifest: ArchiveManifest = {
    takenAt: now().toISOString(),
    documents: Number(counted[0]?.count ?? 0),
    objects: expected.length,
    bytes: expected.reduce((total, item) => total + item.byteSize, 0),
    copiedThisRun: 0,
    expectedDigest: digestOf(expected),
    recoverable: [],
    lost: [],
    mismatched: [],
    source: 'blob-store',
    archive: options.archive.target,
  };

  // One pass, two metadata calls per object. That is the cost of an incremental backup that
  // also notices loss: the archive is asked whether it already has the object, and anything
  // it already has is checked against the source, because an original that disappeared from
  // Storage is exactly what nobody would otherwise see.
  for (const reference of expected) {
    if (await options.archive.exists(reference.key)) {
      if (!(await options.source.exists(reference.key))) {
        if (manifest.recoverable.length < PROBLEM_CAP) manifest.recoverable.push(reference);
        progress(`finns bara i arkivet: ${reference.filename}`);
      }
      continue;
    }

    let bytes: Uint8Array | null = null;
    try {
      bytes = await options.source.get(reference.key);
    } catch {
      bytes = null;
    }

    if (!bytes) {
      // The row promises a file the storage does not have. Whether that is recoverable
      // depends on the archive, and we already know the answer: `exists` said no.
      if (manifest.lost.length < PROBLEM_CAP) manifest.lost.push(reference);
      progress(`saknas i lagringen och i arkivet: ${reference.filename}`);
      continue;
    }

    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== reference.checksum || bytes.byteLength !== reference.byteSize) {
      if (manifest.mismatched.length < PROBLEM_CAP) manifest.mismatched.push(reference);
      progress(`hashen stämmer inte, kopieras inte: ${reference.filename}`);
      continue;
    }

    if (!options.dryRun) await options.archive.put(reference.key, bytes);
    manifest.copiedThisRun += 1;
    progress(`kopierad: ${reference.filename} (${bytes.byteLength} byte)`);
  }

  if (!options.dryRun) {
    await writeManifest(options.archive, manifest);
  }

  return { ...manifest, tookMs: Date.now() - started, dryRun: options.dryRun === true };
}

export async function writeManifest(archive: ObjectArchive, manifest: ArchiveManifest): Promise<void> {
  await archive.put(
    MANIFEST_KEY,
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    'application/json',
  );
}

export async function readManifest(archive: ObjectArchive): Promise<ArchiveManifest | null> {
  const bytes = await archive.get(MANIFEST_KEY);
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as ArchiveManifest;
}

// ---------------------------------------------------------------------------
// Putting them back
// ---------------------------------------------------------------------------

export interface RestoreResult {
  documents: number;
  /** Already present in Storage and hashing correctly. Left alone. */
  intact: number;
  restored: number;
  /** In neither Storage nor the archive. Named, because someone has to be told. */
  lost: DocumentReference[];
  /** In the archive but not matching their own key. Not written. */
  refused: DocumentReference[];
  bytes: number;
  tookMs: number;
  dryRun: boolean;
}

/**
 * Restores the originals into the product's own storage, through the product's own
 * `BlobStore`.
 *
 * Through `put` rather than into the bucket underneath, for two reasons that both matter.
 * The Storage API is what recreates the `storage.objects` metadata without which Supabase
 * will not serve the file even when the bytes are there. And `put` derives the key from the
 * bytes, so a restored object either lands exactly where the database expects it or lands
 * somewhere else and is caught — it cannot quietly take the right name with the wrong
 * contents.
 */
export async function restoreDocuments(options: {
  db: Queryable;
  archive: ObjectArchive;
  destination: BlobStore;
  /** Re-put everything, not only what is missing. For a bucket that is intact but suspect. */
  all?: boolean;
  dryRun?: boolean;
  onProgress?: (message: string) => void;
}): Promise<RestoreResult> {
  const progress = options.onProgress ?? (() => {});
  const started = Date.now();
  const expected = await references(options.db);

  const result: RestoreResult = {
    documents: expected.length,
    intact: 0,
    restored: 0,
    lost: [],
    refused: [],
    bytes: 0,
    tookMs: 0,
    dryRun: options.dryRun === true,
  };

  for (const reference of expected) {
    if (!options.all && (await options.destination.exists(reference.key))) {
      result.intact += 1;
      continue;
    }

    const bytes = await options.archive.get(reference.key);
    if (!bytes) {
      result.lost.push(reference);
      progress(`finns inte i arkivet: ${reference.filename}`);
      continue;
    }

    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== reference.checksum) {
      result.refused.push(reference);
      progress(`arkivets kopia matchar inte databasen, skriver inte: ${reference.filename}`);
      continue;
    }

    if (!options.dryRun) {
      const stored = await options.destination.put(bytes, { contentType: 'application/octet-stream' });
      if (stored.key !== reference.key) {
        result.refused.push(reference);
        progress(`nyckeln ändrades vid skrivning: ${reference.filename}`);
        continue;
      }
    }

    result.restored += 1;
    result.bytes += bytes.byteLength;
    progress(`återställd: ${reference.filename}`);
  }

  result.tookMs = Date.now() - started;
  return result;
}

// ---------------------------------------------------------------------------
// The alarm
// ---------------------------------------------------------------------------

export interface DocumentBackupCheckOptions {
  db: Queryable;
  archive: ObjectArchive;
  /**
   * The product's own storage, when the caller has it.
   *
   * Without it this check can only report what the last backup *recorded*, which means an
   * original disappearing from Storage stays invisible until the next nightly run. With it,
   * the same small sample is probed on both sides, so the loss is noticed within a minute
   * and named as recoverable or not.
   */
  source?: BlobStore;
  /** How old the manifest may be. Default 26 hours: a nightly run plus slack. */
  maxAgeMs?: number;
  /**
   * How many of the newest already-covered documents to probe in the archive.
   *
   * Anchored to the manifest's own timestamp, so a file uploaded after the last run is not
   * reported as a gap — that is ordinary lag, and alarming on it daily would teach the owner
   * to ignore the alarm.
   */
  sampleSize?: number;
  now?: () => Date;
}

/**
 * Is there a copy of the documents, is it recent, and does it actually contain them?
 *
 * Three questions rather than one, because a backup fails in three unrelated ways and two of
 * them are quiet. A scheduler that stopped leaves a manifest that simply stops moving. A run
 * that is failing per object still writes a manifest. And a bucket that was never reachable
 * leaves no manifest at all — which reads exactly like "not configured yet", so the check
 * says which of the two it is.
 */
export function documentBackupCheck(options: DocumentBackupCheckOptions): Check {
  const maxAgeMs = options.maxAgeMs ?? 26 * 3_600_000;
  const sampleSize = options.sampleSize ?? 10;
  const now = options.now ?? (() => new Date());

  return {
    key: 'document_backup',
    run: async (): Promise<CheckResult> => {
      const { rows: counted } = await options.db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM app.document',
      );
      const documents = Number(counted[0]?.count ?? 0);

      const manifest = await readManifest(options.archive);
      if (!manifest) {
        if (documents === 0) {
          return ok({
            key: 'document_backup',
            severity: 'critical',
            title: 'Inga dokument att kopiera än',
            detail: 'Arkivet är konfigurerat men tomt, vilket är rätt: det finns inga original.',
            fields: { documents: 0, archive: options.archive.target },
          });
        }
        return failing({
          key: 'document_backup',
          severity: 'critical',
          title: `Ingen kopia av ${documents} dokument finns — de kan inte återställas`,
          detail:
            'Arkivet svarar men innehåller ingen manifestfil, så säkerhetskopieringen har ' +
            'aldrig lyckats köra. Supabases egna kopior innehåller inte Storage, så just nu ' +
            'är originalen den enda delen av minnet som inte går att få tillbaka. Kör ' +
            'pnpm --filter @photographic/ops backup-documents och läs felet.',
          fields: { documents, archive: options.archive.target },
        });
      }

      const ageMs = now().getTime() - new Date(manifest.takenAt).getTime();
      const ageHours = Math.round(ageMs / 360_000) / 10;
      const fields = {
        documents,
        archived: manifest.objects,
        bytes: manifest.bytes,
        ageHours,
        lost: manifest.lost.length,
        recoverable: manifest.recoverable.length,
        mismatched: manifest.mismatched.length,
      };

      if (ageMs > maxAgeMs) {
        return failing({
          key: 'document_backup',
          severity: 'critical',
          title: `Dokumentkopian är ${ageHours} h gammal — kopieringen har stannat`,
          detail:
            'Ett schema som slutat köra ser ut precis som ett som kör, ända till dagen ' +
            'någon behöver kopian. Kontrollera det schemalagda jobbet (GitHub Actions ' +
            '"Dokumentarkiv") och att DOCUMENT_ARCHIVE_S3_*-nycklarna fortfarande gäller.',
          fields,
        });
      }

      if (manifest.lost.length > 0) {
        return failing({
          key: 'document_backup',
          severity: 'critical',
          title: `${manifest.lost.length} original saknas både i lagringen och i arkivet`,
          detail:
            `Först i listan: ${manifest.lost[0]?.filename}. Raden finns kvar, filen inte. ` +
            'Texten och sammanfattningen är sökbara än, originalet är borta — säg det till ' +
            'personen med filnamn och datum.',
          fields,
        });
      }

      if (manifest.mismatched.length > 0) {
        return failing({
          key: 'document_backup',
          severity: 'critical',
          title: `${manifest.mismatched.length} original hashar inte till det databasen säger`,
          detail:
            `Först i listan: ${manifest.mismatched[0]?.filename}. Filen kopierades medvetet ` +
            'inte: att arkivera den under originalets namn skulle göra ett upptäckbart fel ' +
            'permanent.',
          fields,
        });
      }

      if (manifest.recoverable.length > 0) {
        return failing({
          key: 'document_backup',
          severity: 'warning',
          title: `${manifest.recoverable.length} original finns bara i arkivet`,
          detail:
            'De har försvunnit ur Supabase Storage men går att få tillbaka: kör ' +
            'pnpm --filter @photographic/ops restore-documents.',
          fields,
        });
      }

      // Did the run actually copy what it claims? Probe the newest documents that existed
      // before it started.
      const { rows: sample } = await options.db.query<{ storage_key: string; filename: string }>(
        `SELECT storage_key, filename FROM app.document
         WHERE created_at < $1 ORDER BY created_at DESC LIMIT ${Number(sampleSize)}`,
        [manifest.takenAt],
      );
      const missing: string[] = [];
      const goneFromStorage: string[] = [];
      for (const row of sample) {
        if (!(await options.archive.exists(row.storage_key))) missing.push(row.filename);
        if (options.source && !(await options.source.exists(row.storage_key))) {
          goneFromStorage.push(row.filename);
        }
      }

      // Checked before the archive gap, because this one is live data loss rather than a
      // backup problem: the product will hand a person "Filen finns inte längre i lagringen"
      // for a document it still lists.
      if (goneFromStorage.length > 0) {
        const recoverable = goneFromStorage.length - missing.length;
        return failing({
          key: 'document_backup',
          severity: 'critical',
          title: `${goneFromStorage.length} original har försvunnit ur Storage`,
          detail:
            `Först: ${goneFromStorage[0]}. Raden finns, filen inte. ` +
            (recoverable > 0
              ? 'Arkivet har dem: kör pnpm --filter @photographic/ops restore-documents.'
              : 'Arkivet har dem inte heller — de är borta.'),
          fields: { ...fields, probed: sample.length, goneFromStorage: goneFromStorage.length },
        });
      }

      if (missing.length > 0) {
        return failing({
          key: 'document_backup',
          severity: 'critical',
          title: `Kopian är färsk men ${missing.length} av ${sample.length} kontrollerade dokument finns inte i den`,
          detail:
            `Först: ${missing[0]}. Jobbet kör alltså, men lyckas inte med objekten — det är ` +
            'den farligaste varianten, eftersom manifestet ser friskt ut. Läs jobbets logg.',
          fields: { ...fields, probed: sample.length },
        });
      }

      return ok({
        key: 'document_backup',
        severity: 'critical',
        title: `Dokumenten är kopierade utanför Supabase (${manifest.objects} objekt, ${ageHours} h sedan)`,
        fields: { ...fields, probed: sample.length },
      });
    },
  };
}
