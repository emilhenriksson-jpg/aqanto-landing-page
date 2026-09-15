/**
 * A fingerprint of a memory, and the comparison that turns two of them into a proof.
 *
 * This exists because "the restore worked" is not a thing anyone can see. A restored
 * database answers queries, the web app renders, and every screen looks plausible whether
 * or not a table came back short. The only honest test is to describe the memory before,
 * describe it after, and diff the two descriptions — which is what this is.
 *
 * Three properties it needs, and the reasons they are not obvious:
 *
 * - **Content, not statistics.** Row counts alone would pass a restore that returned the
 *   right number of rows with the wrong contents, so every table also gets a digest over
 *   its rows in a deterministic order.
 * - **Storage, not just Postgres.** Supabase's own backups cover the database and
 *   explicitly not the objects in Storage, so a fingerprint that stopped at Postgres would
 *   certify exactly the half that is safe and say nothing about the half that is not. Each
 *   document's bytes are fetched and re-hashed.
 * - **Comparable across targets.** The whole point is to compare production with a scratch
 *   restore, so nothing host-specific may enter the compared surface. The connection target
 *   is recorded for the report and excluded from the diff.
 */

import { createHash } from 'node:crypto';

import type { BlobStore } from '@photographic/documents';

import type { Queryable } from './postgres-checks.js';

/** Tables whose contents are the memory. Order fixed so two fingerprints line up. */
export const FINGERPRINTED_TABLES = [
  'person',
  'room',
  'membership',
  'item',
  'event',
  'proposal',
  'document',
  'chunk',
  'profile',
  'brief',
  'invite',
  'credential',
  'client_session',
  'client_grant',
  'oauth_client',
  'oauth_token',
  'storage_object',
  'storage_usage',
  'export_job',
  'account_deletion',
  'job',
  'access_log',
  'room_read_state',
  'schema_migrations',
] as const;

/**
 * How each table is digested.
 *
 * A stable order and the columns that carry meaning — never `created_at` where a restore
 * legitimately preserves it but a re-import would not, and never a serial that a restore
 * keeps but a rebuild would renumber. `event` is digested over `seq` and the payload
 * because it is the log the product calls its source of truth: if that digest matches,
 * every projection can be argued from it.
 */
const DIGEST_EXPRESSIONS: Partial<Record<(typeof FINGERPRINTED_TABLES)[number], string>> = {
  event: `md5(concat_ws('|', seq, event_type, room_id, actor_person_id, payload::text))`,
  item: `md5(concat_ws('|', id, room_id, short_id, kind, body, status, deleted_at, purge_after))`,
  document: `md5(concat_ws('|', id, room_id, filename, mime_type, byte_size, storage_key, checksum))`,
  chunk: `md5(concat_ws('|', id, document_id, ord, text))`,
  person: `md5(concat_ws('|', id, display_name, handle, email, phone))`,
  room: `md5(concat_ws('|', id, kind, title, created_by))`,
  membership: `md5(concat_ws('|', room_id, person_id, role))`,
  proposal: `md5(concat_ws('|', id, room_id, status, body, structured::text))`,
  storage_object: `md5(concat_ws('|', person_id, checksum, byte_size, storage_key, ref_count))`,
  schema_migrations: `md5(id)`,
};

const ORDER_BY: Partial<Record<(typeof FINGERPRINTED_TABLES)[number], string>> = {
  event: 'seq',
  chunk: 'document_id, ord',
  membership: 'room_id, person_id',
  storage_object: 'person_id, checksum',
  schema_migrations: 'id',
};

export interface TableFingerprint {
  count: number;
  /** md5 over the per-row digests in a fixed order. Empty string for an empty table. */
  digest: string;
}

export interface DocumentVerification {
  documents: number;
  checked: number;
  bytes: number;
  /** Rows whose blob is not in the store at all. The memory is gone, not damaged. */
  missing: Array<{ id: string; filename: string; storageKey: string }>;
  /** Rows whose blob is present but hashes to something else. Worse: it looks fine. */
  corrupt: Array<{ id: string; filename: string; storageKey: string }>;
}

export interface EventLogFingerprint {
  count: number;
  minSeq: number | null;
  maxSeq: number | null;
  /** `count` versus the span of `seq`. Non-zero means rows are missing from the middle. */
  gaps: number;
}

export interface MemoryFingerprint {
  takenAt: string;
  /** For the report only. Excluded from every comparison, and never a credential. */
  target: { database: string; storage: string; storageKind: string };
  migrations: { files: string[]; applied: string[] };
  tables: Record<string, TableFingerprint>;
  eventLog: EventLogFingerprint;
  documents: DocumentVerification;
}

export interface FingerprintOptions {
  db: Queryable;
  blobs: BlobStore;
  /** For the report only. */
  target: { database: string; storage: string; storageKind: string };
  migrationFiles: string[];
  /** How many documents to fetch and re-hash. Default every one. */
  documentLimit?: number;
  onProgress?: (message: string) => void;
}

export async function takeFingerprint(options: FingerprintOptions): Promise<MemoryFingerprint> {
  const { db } = options;
  const progress = options.onProgress ?? (() => {});

  const tables: Record<string, TableFingerprint> = {};
  for (const table of FINGERPRINTED_TABLES) {
    const digestExpression = DIGEST_EXPRESSIONS[table] ?? `md5(t::text)`;
    const order = ORDER_BY[table] ?? 'md5(t::text)';
    const { rows } = await db.query<{ count: string; digest: string | null }>(
      `SELECT count(*)::text AS count,
              md5(coalesce(string_agg(${digestExpression}, '' ORDER BY ${order}), '')) AS digest
       FROM app.${table} t`,
    );
    tables[table] = {
      count: Number(rows[0]?.count ?? 0),
      digest: rows[0]?.digest ?? '',
    };
    progress(`${table}: ${tables[table].count}`);
  }

  const { rows: eventRows } = await db.query<{ count: string; min: string | null; max: string | null }>(
    `SELECT count(*)::text AS count, min(seq)::text AS min, max(seq)::text AS max FROM app.event`,
  );
  const count = Number(eventRows[0]?.count ?? 0);
  const minSeq = eventRows[0]?.min === null || eventRows[0]?.min === undefined ? null : Number(eventRows[0].min);
  const maxSeq = eventRows[0]?.max === null || eventRows[0]?.max === undefined ? null : Number(eventRows[0].max);
  const eventLog: EventLogFingerprint = {
    count,
    minSeq,
    maxSeq,
    // A `bigserial` gap is not proof of loss on its own — a rolled back transaction burns a
    // value — but on a log that only ever appends inside committed transactions it is the
    // cheapest signal that a restore came back short in the middle rather than at the end.
    gaps: minSeq === null || maxSeq === null ? 0 : Math.max(0, maxSeq - minSeq + 1 - count),
  };

  const { rows: ledger } = await db.query<{ id: string }>(
    'SELECT id FROM app.schema_migrations ORDER BY id',
  );

  const documents = await verifyDocuments({
    db,
    blobs: options.blobs,
    ...(options.documentLimit === undefined ? {} : { limit: options.documentLimit }),
    onProgress: progress,
  });

  return {
    takenAt: new Date().toISOString(),
    target: options.target,
    migrations: { files: options.migrationFiles, applied: ledger.map((row) => row.id) },
    tables,
    eventLog,
    documents,
  };
}

/**
 * Fetches every document's bytes and re-hashes them.
 *
 * This is the part a database-only check cannot do, and it is the half of the memory that
 * Supabase's backups do not cover. The store is content-addressed, so the key *is* the
 * expected hash — there is no separate manifest to trust and no way for a corrupt object to
 * agree with its own name.
 */
export async function verifyDocuments(input: {
  db: Queryable;
  blobs: BlobStore;
  limit?: number;
  onProgress?: (message: string) => void;
}): Promise<DocumentVerification> {
  const progress = input.onProgress ?? (() => {});
  const { rows: total } = await input.db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM app.document',
  );

  const { rows } = await input.db.query<{
    id: string;
    filename: string;
    storage_key: string;
    checksum: string;
    byte_size: string;
  }>(
    `SELECT id, filename, storage_key, checksum, byte_size::text AS byte_size
     FROM app.document ORDER BY created_at, id ${input.limit === undefined ? '' : 'LIMIT ' + Number(input.limit)}`,
  );

  const verification: DocumentVerification = {
    documents: Number(total[0]?.count ?? 0),
    checked: 0,
    bytes: 0,
    missing: [],
    corrupt: [],
  };

  for (const row of rows) {
    const where = { id: row.id, filename: row.filename, storageKey: row.storage_key };
    let bytes: Uint8Array;
    try {
      bytes = await input.blobs.get(row.storage_key);
    } catch {
      verification.missing.push(where);
      progress(`saknas: ${row.filename}`);
      continue;
    }

    verification.checked += 1;
    verification.bytes += bytes.byteLength;
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== row.checksum || bytes.byteLength !== Number(row.byte_size)) {
      verification.corrupt.push(where);
      progress(`skadad: ${row.filename}`);
    }
  }

  return verification;
}

export interface FingerprintDifference {
  what: string;
  before: string;
  after: string;
}

/**
 * What changed between two fingerprints.
 *
 * An empty list is the proof. A restore is expected to reproduce the source exactly, so
 * anything here — a count, a digest, a missing blob — is data that did not come back, and it
 * is named specifically enough to go looking for.
 */
export function diffFingerprints(
  before: MemoryFingerprint,
  after: MemoryFingerprint,
): FingerprintDifference[] {
  const differences: FingerprintDifference[] = [];

  const applied = (fingerprint: MemoryFingerprint): string => fingerprint.migrations.applied.join(',');
  if (applied(before) !== applied(after)) {
    differences.push({ what: 'migrations.applied', before: applied(before), after: applied(after) });
  }

  for (const table of FINGERPRINTED_TABLES) {
    const one = before.tables[table];
    const two = after.tables[table];
    if (!one || !two) continue;
    if (one.count !== two.count) {
      differences.push({
        what: `${table}.count`,
        before: String(one.count),
        after: String(two.count),
      });
    }
    if (one.digest !== two.digest) {
      differences.push({
        what: `${table}.digest`,
        before: one.digest.slice(0, 12),
        after: two.digest.slice(0, 12),
      });
    }
  }

  if (before.eventLog.count !== after.eventLog.count) {
    differences.push({
      what: 'eventLog.count',
      before: String(before.eventLog.count),
      after: String(after.eventLog.count),
    });
  }
  if (after.eventLog.gaps > before.eventLog.gaps) {
    differences.push({
      what: 'eventLog.gaps',
      before: String(before.eventLog.gaps),
      after: String(after.eventLog.gaps),
    });
  }

  if (before.documents.documents !== after.documents.documents) {
    differences.push({
      what: 'documents.count',
      before: String(before.documents.documents),
      after: String(after.documents.documents),
    });
  }
  if (after.documents.missing.length > 0) {
    differences.push({
      what: 'documents.missing',
      before: '0',
      after: after.documents.missing.map((doc) => doc.filename).join(','),
    });
  }
  if (after.documents.corrupt.length > 0) {
    differences.push({
      what: 'documents.corrupt',
      before: '0',
      after: after.documents.corrupt.map((doc) => doc.filename).join(','),
    });
  }

  return differences;
}
