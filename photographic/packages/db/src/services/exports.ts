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
import type { BlobStore, BlobUpload } from '@photographic/documents';
import { exportKeyFor } from '@photographic/documents';
import { buildExportArchive, type ExportScope, type ZipSink } from '@photographic/export';
import type { Pool } from 'pg';

import { execute, queryOne, queryRows } from '../pool.js';
import { appendEvent } from './events.js';
import { PgExportSource } from './export-source.js';
import { workerId } from './jobs.js';

export const DOWNLOAD_TOKEN_PREFIX = 'pgm_dl_';
/**
 * One hour.
 *
 * It was seven days, to match the archive's own life, on the reasoning that the link
 * arrives by email and a person may open it days later. That is the wrong trade for this
 * particular object: the archive is everything someone has ever told the system, in one
 * file, and a week-long URL that anyone holding it can replay is a bigger exposure than
 * any single memory in it. A link is minted from a screen the person is already looking
 * at, so an hour is generous.
 */
export const DOWNLOAD_TTL_SECONDS = 60 * 60;

/**
 * How long a transfer that broke may be retried.
 *
 * The link is single-use in the sense that matters: once a download has *completed* the
 * token is dead. Until then, a transfer that failed halfway — the normal case for a
 * multi-gigabyte archive on a phone — may be tried again inside this window. Without it,
 * "single-use" would mean a person on a train has to come back to the app for every
 * dropped connection.
 */
export const DOWNLOAD_RESUME_SECONDS = 15 * 60;

/** How many attempts a link allows before it is spent regardless. */
export const MAX_DOWNLOAD_ATTEMPTS = 5;

/**
 * How long a worker's claim on an export is believed.
 *
 * Ten minutes, heartbeated while the build runs. Longer than the queue's lease because an
 * archive of ten gigabytes takes real time to write, and the heartbeat is what separates
 * "this is a big export" from "the machine this was running on is gone".
 */
export const EXPORT_LEASE_SECONDS = 10 * 60;

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
 * Writes the archive to storage as it is produced.
 *
 * This used to be a `BufferingSink` that collected every chunk in an array and handed the
 * concatenation to `BlobStore.put` — two copies of the whole archive in a process with
 * two gigabytes to its name, which meant the person with the most to lose was exactly the
 * person who could not export. Now each chunk goes out through `BlobUpload`, and `write`
 * does not resolve until it has: the zip writer is pulled along at the speed of the
 * upload rather than filling memory ahead of it.
 *
 * Nothing here buffers on purpose. What buffering exists is one multipart part inside the
 * upload, which is a constant.
 */
class UploadSink implements ZipSink {
  constructor(private readonly upload: BlobUpload) {}

  async write(chunk: Uint8Array): Promise<void> {
    await this.upload.write(chunk);
  }
}

/**
 * One export at a time in this process, whatever the caller does.
 *
 * The lease in the database stops two machines building the same export. This stops one
 * machine building three at once, which is the version that matters here: each build
 * holds a multipart part and a database connection, and the request path shares both. A
 * queue that could starve the API to deliver an export would be trading the product for
 * one feature of it.
 */
class BuildSlot {
  private held = false;
  private readonly waiting: Array<() => void> = [];

  async take(): Promise<() => void> {
    if (this.held) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next();
        return;
      }
      this.held = false;
    };
  }
}

const buildSlot = new BuildSlot();

export class PgExports {
  private readonly source: PgExportSource;
  private readonly worker: string;

  constructor(
    private readonly pool: Pool,
    private readonly blobs: BlobStore,
    options: { worker?: string } = {},
  ) {
    this.source = new PgExportSource(pool);
    // The same shape as the job queue's worker id, and for the same reason: a lease that
    // lapsed should say who was holding it.
    this.worker = options.worker ?? workerId();
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
   * Puts exports abandoned by a dead worker back in the queue, or fails them visibly.
   *
   * The failure this recovers from is ordinary: a Fly restart in the middle of a build.
   * Before this existed, such an export sat at `running` for ever — the person had asked
   * to take their memory with them and the answer was a spinner that never resolved,
   * which is the worst available way to break that particular promise.
   *
   * The half-written object is deleted on the way past. An archive nobody will finish is
   * storage nobody is paying for on purpose.
   */
  async reapStuck(leaseSeconds = EXPORT_LEASE_SECONDS): Promise<{
    requeued: number;
    failed: number;
  }> {
    const stuck = await queryRows<{ id: string; attempts: number; pending_key: string | null }>(
      this.pool,
      `SELECT id, attempts, pending_key FROM app.export_job
       WHERE status = 'running'
         AND coalesce(lease_expires_at, requested_at + ($1 || ' seconds')::interval) < now()
       ORDER BY requested_at
       LIMIT 20`,
      [leaseSeconds],
    );

    let requeued = 0;
    let failed = 0;

    for (const job of stuck) {
      if (job.pending_key) {
        // Best effort: a key we cannot delete is a stray object, while a throw here would
        // leave the row stuck, which is the thing being fixed.
        await this.blobs.delete(job.pending_key).catch(() => undefined);
      }

      const exhausted = await queryOne<{ status: ExportStatus }>(
        this.pool,
        `UPDATE app.export_job
         SET status = CASE WHEN attempts >= max_attempts THEN 'failed'::app.export_status
                           ELSE 'pending'::app.export_status END,
             locked_by = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL,
             pending_key = NULL,
             error = CASE WHEN attempts >= max_attempts
                          THEN 'Exporten avbröts flera gånger innan den blev klar. Försök igen, eller hör av dig.'
                          ELSE error END,
             finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
         WHERE id = $1 AND status = 'running'
         RETURNING status`,
        [job.id],
      );

      if (exhausted?.status === 'failed') failed += 1;
      else if (exhausted) requeued += 1;
    }

    return { requeued, failed };
  }

  /** Exports waiting, running, stuck and failed. Read by the queue endpoint. */
  async stats(): Promise<{
    pending: number;
    running: number;
    expiredLeases: number;
    failed: number;
    ready: number;
    oldestPendingAt: Date | null;
    oldestPendingSeconds: number;
  }> {
    const row = await queryOne<{
      pending: string;
      running: string;
      expired_leases: string;
      failed: string;
      ready: string;
      oldest_pending_at: Date | null;
    }>(this.pool, `SELECT * FROM app.export_stats`);

    const oldestPendingAt = row?.oldest_pending_at ?? null;
    return {
      pending: Number(row?.pending ?? 0),
      running: Number(row?.running ?? 0),
      expiredLeases: Number(row?.expired_leases ?? 0),
      failed: Number(row?.failed ?? 0),
      ready: Number(row?.ready ?? 0),
      oldestPendingAt,
      oldestPendingSeconds: oldestPendingAt
        ? Math.max(0, Math.round((Date.now() - oldestPendingAt.getTime()) / 1000))
        : 0,
    };
  }

  /**
   * Builds one archive.
   *
   * A failure is recorded on the row rather than thrown away, because the person is
   * waiting for an email and "it silently never arrived" is the worst of the available
   * outcomes.
   */
  async run(exportId: string): Promise<ExportJobRecord | null> {
    // A leased claim, and one that a lapsed lease can win. `attempts` goes up here rather
    // than on failure, so an export that kills its worker every time still runs out of
    // attempts and ends up failed-and-visible instead of running-for-ever.
    const claimed = await queryOne<JobRow & { pending_key: string | null }>(
      this.pool,
      `UPDATE app.export_job
       SET status = 'running',
           attempts = attempts + 1,
           locked_by = $2,
           lease_expires_at = now() + ($3 || ' seconds')::interval,
           heartbeat_at = now(),
           pending_key = $4
       WHERE id = $1
         AND (status = 'pending'
              OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()))
       RETURNING ${COLUMNS}, pending_key`,
      [exportId, this.worker, EXPORT_LEASE_SECONDS, exportKeyFor(exportId)],
    );
    if (!claimed) return null;

    // Never more than one build in this process, and never one that outlives its lease
    // without saying so.
    const release = await buildSlot.take();
    const heartbeat = setInterval(
      () => {
        void execute(
          this.pool,
          `UPDATE app.export_job
           SET heartbeat_at = now(), lease_expires_at = now() + ($2 || ' seconds')::interval
           WHERE id = $1 AND locked_by = $3`,
          [exportId, EXPORT_LEASE_SECONDS, this.worker],
        ).catch(() => undefined);
      },
      (EXPORT_LEASE_SECONDS / 3) * 1000,
    );
    heartbeat.unref();

    const storageKey = exportKeyFor(exportId);
    let upload: BlobUpload | null = null;

    try {
      // The object is opened before the first byte exists and is written to as the zip is
      // produced. Its key is recorded on the row first, so a crash leaves something a
      // reaper can delete rather than an orphan nobody knows the name of.
      upload = await this.blobs.createUpload({
        key: storageKey,
        contentType: 'application/zip',
      });

      const result = await buildExportArchive(
        { source: this.source, blobs: this.blobs },
        {
          personId: claimed.person_id,
          scope: claimed.scope,
          requestedRooms: claimed.requested_rooms,
        },
        new UploadSink(upload),
      );

      const stored = await upload.complete();
      upload = null;

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

      await execute(
        this.pool,
        `UPDATE app.export_job SET pending_key = NULL, lease_expires_at = NULL, locked_by = NULL
         WHERE id = $1`,
        [exportId],
      );

      return finished ? toRecord(finished) : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Abandon the object before touching the row. A multipart upload nobody completed
      // is billed for its parts until it is aborted, and a half-written archive under a
      // key a download link could reach is worse than no archive.
      if (upload) await upload.abort().catch(() => undefined);
      await this.blobs.delete(storageKey).catch(() => undefined);

      // Failed only once the attempts are spent. Anything else goes back to `pending`, so
      // a blip — a storage timeout, a restarted database — is retried rather than being
      // the end of a person's attempt to take their memory with them.
      const failed = await queryOne<JobRow>(
        this.pool,
        `UPDATE app.export_job
         SET status = CASE WHEN attempts >= max_attempts THEN 'failed'::app.export_status
                           ELSE 'pending'::app.export_status END,
             error = $2,
             locked_by = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL,
             pending_key = NULL,
             finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [exportId, message.slice(0, 500)],
      );
      return failed ? toRecord(failed) : null;
    } finally {
      clearInterval(heartbeat);
      release();
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
   * Claims a download token and hands back the archive as a stream.
   *
   * Single-use, in the sense that survives a dropped connection: the claim is one atomic
   * statement, a completed transfer spends the token for good, and an attempt that broke
   * may be retried inside `DOWNLOAD_RESUME_SECONDS` of the first one. So a shared or
   * replayed link is dead, while the person whose train went into a tunnel is not made to
   * start over.
   *
   * Unknown, expired, spent and pointing-at-a-deleted-export are one answer, like every
   * other token path here: the difference tells the holder of a guessed link what kind of
   * guess it was.
   *
   * The bytes are streamed rather than returned. This is the other half of the memory
   * problem — reading a ten-gigabyte archive into the process to hand it to a response
   * would take the machine down just as surely as building it there did.
   */
  async resolveDownload(rawToken: string): Promise<{
    filename: string;
    byteSize: number | null;
    checksum: string | null;
    stream: AsyncIterable<Uint8Array>;
    /** Call once the response has actually been delivered. Spends the token. */
    complete: () => Promise<void>;
  } | null> {
    const tokenHash = hashToken(rawToken);

    // One statement: the check, the attempt count and the window all move together, so
    // two requests arriving at once cannot both be the first use.
    const row = await queryOne<{
      export_id: string;
      storage_key: string | null;
      byte_size: string | null;
      checksum: string | null;
      person_handle: string | null;
      requested_at: Date;
    }>(
      this.pool,
      `UPDATE app.export_download d
       SET first_used_at = coalesce(d.first_used_at, now()),
           last_used_at = now(),
           use_count = d.use_count + 1
       FROM app.export_job j, app.person p
       WHERE d.token_hash = $1
         AND j.id = d.export_id
         AND p.id = j.person_id
         AND d.expires_at > now()
         AND d.consumed_at IS NULL
         AND d.use_count < $2
         AND (d.first_used_at IS NULL OR d.first_used_at > now() - ($3 || ' seconds')::interval)
         AND j.expires_at > now()
         AND j.status = 'ready'
       RETURNING d.export_id, j.storage_key, j.byte_size, j.checksum,
                 p.handle AS person_handle, j.requested_at`,
      [tokenHash, MAX_DOWNLOAD_ATTEMPTS, DOWNLOAD_RESUME_SECONDS],
    );

    if (!row?.storage_key) return null;

    const day = row.requested_at.toISOString().slice(0, 10);
    const who = row.person_handle ?? 'photographic';
    const pool = this.pool;

    return {
      filename: `photographic-export-${who}-${day}.zip`,
      byteSize: row.byte_size === null ? null : Number(row.byte_size),
      checksum: row.checksum,
      stream: this.blobs.getStream(row.storage_key),
      complete: async () => {
        await execute(
          pool,
          `UPDATE app.export_download SET consumed_at = now()
           WHERE token_hash = $1 AND consumed_at IS NULL`,
          [tokenHash],
        );
      },
    };
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
