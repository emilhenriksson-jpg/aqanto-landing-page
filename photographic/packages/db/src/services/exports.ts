/**
 * The export job: request, run, download.
 *
 * Never synchronous. An export reads a person's entire log and every file they have
 * uploaded, and doing that inside a request means a timeout for exactly the people with
 * the most in it. So a request records a row, a job builds the archive, and the person
 * gets a link.
 *
 * The link is signed rather than authenticated because the archive is delivered by email
 * and the browser that opens it may have no session. Only a hash of the token is stored,
 * for the same reason `oauth_token` stores only hashes: a dump of the table must not be
 * a set of working links to people's entire memory.
 */

import { createHash, randomBytes } from 'node:crypto';

import { NotFoundError, ValidationError, type Actor, type PersonId, type RoomId } from '@photographic/core';
import type { BlobStore } from '@photographic/documents';
import { buildExportArchive, type ExportScope, type ZipSink } from '@photographic/export';
import type { Pool } from 'pg';

import { execute, queryOne, queryRows } from '../pool.js';
import { appendEvent } from './events.js';
import { PgExportSource } from './export-source.js';

export const DOWNLOAD_TOKEN_PREFIX = 'pgm_dl_';
/** Seven days, as the spec says. Long enough to notice the email. */
export const DOWNLOAD_TTL_SECONDS = 7 * 24 * 60 * 60;

export type ExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired';

export interface ExportJobRecord {
  id: string;
  personId: PersonId;
  scope: ExportScope;
  requestedRooms: RoomId[];
  status: ExportStatus;
  byteSize: number | null;
  checksum: string | null;
  eventCount: number | null;
  itemCount: number | null;
  documentCount: number | null;
  throughSeq: number | null;
  error: string | null;
  requestedAt: Date;
  finishedAt: Date | null;
  expiresAt: Date;
}

interface JobRow {
  id: string;
  person_id: string;
  scope: ExportScope;
  requested_rooms: string[];
  status: ExportStatus;
  storage_key: string | null;
  byte_size: string | null;
  checksum: string | null;
  event_count: number | null;
  item_count: number | null;
  document_count: number | null;
  through_seq: string | null;
  error: string | null;
  requested_at: Date;
  finished_at: Date | null;
  expires_at: Date;
}

const COLUMNS = `id, person_id, scope, requested_rooms, status, storage_key, byte_size, checksum,
                 event_count, item_count, document_count, through_seq, error, requested_at,
                 finished_at, expires_at`;

function toRecord(row: JobRow): ExportJobRecord {
  return {
    id: row.id,
    personId: row.person_id as PersonId,
    scope: row.scope,
    requestedRooms: row.requested_rooms as RoomId[],
    status: row.status,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    checksum: row.checksum,
    eventCount: row.event_count,
    itemCount: row.item_count,
    documentCount: row.document_count,
    throughSeq: row.through_seq === null ? null : Number(row.through_seq),
    error: row.error,
    requestedAt: row.requested_at,
    finishedAt: row.finished_at,
    expiresAt: row.expires_at,
  };
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Buffers the archive, then writes it as one object.
 *
 * The honest name for what this is: the one place the streaming stops. `BlobStore.put`
 * takes bytes, because that is what every implementation of it can do — Supabase
 * Storage's REST API and the S3 single-part PUT both want a body. A multipart upload
 * would let this stream all the way through and is the right next step; until then the
 * archive is resident once, briefly, and `ZipWriter` refusing anything over 4 GB is
 * what stops that from being unbounded.
 */
class BufferingSink implements ZipSink {
  private readonly chunks: Uint8Array[] = [];
  write(chunk: Uint8Array): void {
    this.chunks.push(new Uint8Array(chunk));
  }
  bytes(): Uint8Array {
    return new Uint8Array(Buffer.concat(this.chunks.map((chunk) => Buffer.from(chunk))));
  }
}

export class PgExports {
  private readonly source: PgExportSource;

  constructor(
    private readonly pool: Pool,
    private readonly blobs: BlobStore,
  ) {
    this.source = new PgExportSource(pool);
  }

  /**
   * Queues an export.
   *
   * `rooms` scope is the explicit, stronger request and is checked against real
   * memberships here as well as when the job runs — a room id in a request body is a
   * request, never a grant.
   */
  async request(
    actor: Actor,
    input: { scope?: ExportScope; rooms?: RoomId[] } = {},
  ): Promise<ExportJobRecord> {
    const scope: ExportScope = input.scope ?? 'own';
    const requested = scope === 'rooms' ? (input.rooms ?? []) : [];

    if (scope === 'rooms' && requested.length === 0) {
      throw new ValidationError(
        'Ange vilka rum du vill exportera i sin helhet, eller begär bara ditt eget minne.',
      );
    }

    const reachable = new Set(
      (
        await queryRows<{ room_id: string }>(
          this.pool,
          `SELECT room_id FROM app.accessible_room_ids($1)`,
          [actor.personId],
        )
      ).map((row) => row.room_id),
    );

    const allowed = requested.filter((roomId) => reachable.has(roomId));
    if (scope === 'rooms' && allowed.length === 0) {
      // Not-found rather than forbidden, like every other denial: naming a room you
      // cannot reach must not confirm that it exists.
      throw new NotFoundError('Hittade inga rum att exportera.');
    }

    const row = await queryOne<JobRow>(
      this.pool,
      `INSERT INTO app.export_job (person_id, scope, requested_rooms)
       VALUES ($1, $2, $3::uuid[])
       RETURNING ${COLUMNS}`,
      [actor.personId, scope, allowed],
    );

    return toRecord(row!);
  }

  async list(actor: Actor): Promise<ExportJobRecord[]> {
    const rows = await queryRows<JobRow>(
      this.pool,
      `SELECT ${COLUMNS} FROM app.export_job
       WHERE person_id = $1
       ORDER BY requested_at DESC
       LIMIT 20`,
      [actor.personId],
    );
    return rows.map(toRecord);
  }

  async get(actor: Actor, exportId: string): Promise<ExportJobRecord | null> {
    const row = await queryOne<JobRow>(
      this.pool,
      `SELECT ${COLUMNS} FROM app.export_job WHERE id = $1 AND person_id = $2`,
      [exportId, actor.personId],
    );
    return row ? toRecord(row) : null;
  }

  /** Queued work, for the job runner. */
  async pending(limit = 3): Promise<ExportJobRecord[]> {
    const rows = await queryRows<JobRow>(
      this.pool,
      `SELECT ${COLUMNS} FROM app.export_job
       WHERE status = 'pending'
       ORDER BY requested_at
       LIMIT $1`,
      [limit],
    );
    return rows.map(toRecord);
  }

  /**
   * Builds one archive.
   *
   * A failure is recorded on the row rather than thrown away, because the person is
   * waiting for an email and "it silently never arrived" is the worst of the available
   * outcomes.
   */
  async run(exportId: string): Promise<ExportJobRecord | null> {
    const claimed = await queryOne<JobRow>(
      this.pool,
      `UPDATE app.export_job SET status = 'running'
       WHERE id = $1 AND status = 'pending'
       RETURNING ${COLUMNS}`,
      [exportId],
    );
    if (!claimed) return null;

    try {
      const sink = new BufferingSink();
      const result = await buildExportArchive(
        { source: this.source, blobs: this.blobs },
        {
          personId: claimed.person_id,
          scope: claimed.scope,
          requestedRooms: claimed.requested_rooms,
        },
        sink,
      );

      const stored = await this.blobs.put(sink.bytes(), { contentType: 'application/zip' });

      const finished = await queryOne<JobRow>(
        this.pool,
        `UPDATE app.export_job
         SET status = 'ready',
             storage_key = $2,
             byte_size = $3,
             checksum = $4,
             event_count = $5,
             item_count = $6,
             document_count = $7,
             through_seq = $8,
             finished_at = now()
         WHERE id = $1
         RETURNING ${COLUMNS}`,
        [
          exportId,
          stored.key,
          result.byteSize,
          result.checksum,
          result.manifest.counts.events,
          result.manifest.counts.items,
          result.manifest.counts.documents,
          result.throughSeq,
        ],
      );

      /**
       * `export.created` in every room the archive covered.
       *
       * The spec's requirement, and the thing that makes a full-transcript export
       * acceptable rather than merely permitted: the other members see in the room's
       * history that a copy was taken, by whom and when. `included` distinguishes "took
       * their own contributions" from "took this whole room", because those are
       * different acts and a single event type would flatten them.
       */
      for (const room of result.touchedRooms) {
        await appendEvent(this.pool, {
          roomId: room.roomId as RoomId,
          eventType: 'export.created',
          payload: {
            export_id: exportId,
            scope: claimed.scope,
            included: room.included,
            through_seq: result.throughSeq,
          },
          actorPersonId: claimed.person_id as PersonId,
          agentClient: 'web',
        });
      }

      return finished ? toRecord(finished) : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await queryOne<JobRow>(
        this.pool,
        `UPDATE app.export_job SET status = 'failed', error = $2, finished_at = now()
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [exportId, message.slice(0, 500)],
      );
      return failed ? toRecord(failed) : null;
    }
  }

  /**
   * Mints a download link. The raw token is returned once and never stored.
   */
  async createDownloadToken(
    actor: Actor,
    exportId: string,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    const job = await this.get(actor, exportId);
    if (!job || job.status !== 'ready') return null;

    const raw = DOWNLOAD_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    // Never past the archive's own expiry: a link outliving what it points at is a link
    // that 404s for reasons the person cannot see.
    const expiresAt = new Date(
      Math.min(Date.now() + DOWNLOAD_TTL_SECONDS * 1000, job.expiresAt.getTime()),
    );

    await execute(
      this.pool,
      `INSERT INTO app.export_download (token_hash, export_id, expires_at)
       VALUES ($1, $2, $3)`,
      [hashToken(raw), exportId, expiresAt],
    );

    return { token: raw, expiresAt };
  }

  /**
   * Resolves a download token to the archive.
   *
   * Unknown, expired and pointing-at-a-deleted-export are one answer, like every other
   * token path here: the difference tells the holder of a guessed link what kind of
   * guess it was.
   */
  async resolveDownload(
    rawToken: string,
  ): Promise<{ filename: string; bytes: Uint8Array } | null> {
    const row = await queryOne<{
      export_id: string;
      storage_key: string | null;
      person_handle: string | null;
      requested_at: Date;
      status: ExportStatus;
    }>(
      this.pool,
      `SELECT d.export_id, j.storage_key, p.handle AS person_handle, j.requested_at, j.status
       FROM app.export_download d
       JOIN app.export_job j ON j.id = d.export_id
       JOIN app.person p ON p.id = j.person_id
       WHERE d.token_hash = $1
         AND d.expires_at > now()
         AND j.expires_at > now()
         AND j.status = 'ready'`,
      [hashToken(rawToken)],
    );

    if (!row?.storage_key) return null;

    await execute(
      this.pool,
      `UPDATE app.export_download
       SET last_used_at = now(), use_count = use_count + 1
       WHERE token_hash = $1`,
      [hashToken(rawToken)],
    );

    const bytes = await this.blobs.get(row.storage_key);
    const day = row.requested_at.toISOString().slice(0, 10);
    const who = row.person_handle ?? 'photographic';

    return { filename: `photographic-export-${who}-${day}.zip`, bytes };
  }

  /**
   * Deletes archives past their seven days.
   *
   * The files go too, not only the rows. An export is a complete copy of someone's
   * memory sitting in object storage; keeping it after the link stopped working would
   * be keeping it for no one's benefit.
   */
  async expireOld(): Promise<number> {
    const due = await queryRows<{ id: string; storage_key: string | null }>(
      this.pool,
      `SELECT id, storage_key FROM app.export_job
       WHERE status = 'ready' AND expires_at <= now()`,
    );

    for (const job of due) {
      if (job.storage_key) await this.blobs.delete(job.storage_key);
    }

    if (due.length === 0) return 0;

    return execute(
      this.pool,
      `UPDATE app.export_job SET status = 'expired', storage_key = NULL
       WHERE id = ANY($1::uuid[])`,
      [due.map((job) => job.id)],
    );
  }
}
