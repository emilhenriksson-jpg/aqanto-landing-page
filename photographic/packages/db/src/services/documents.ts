/**
 * Documents, backed by Postgres and a blob store.
 *
 * `MemoryDocuments` is the reference for behaviour and this is the same code path: both
 * call `ingestDocument`, so the order the steps happen in — refuse an oversized file,
 * write the bytes, reserve the space, extract, chunk — is defined once. What differs is
 * only where the rows go and that the bytes leave the process.
 *
 * The bytes go through `BlobStore`, which is why this file names no storage provider.
 * `LocalBlobStore` in development, `S3BlobStore` for R2 or MinIO, Supabase Storage from
 * `@photographic/supabase` — swapping one for another does not reach the memory model,
 * and that is the whole point of the port.
 */

import type {
  Actor,
  ChunkId,
  DocumentId,
  DocumentPort,
  DocumentSummary,
  ExtractionStatus,
  JobPort,
  LlmPort,
  PersonId,
  ProjectionPort,
  RoomId,
  StorageUsageReport,
} from '@photographic/core';
import { NotFoundError, NotPermittedError, TRASH_RETENTION_DAYS } from '@photographic/core';
import type { BlobStore, StorageLedger } from '@photographic/documents';
import { ingestDocument, storageLimitReached } from '@photographic/documents';
import type { Pool } from 'pg';

import { queryOne, queryRows, withTransaction } from '../pool.js';
import { appendEvent } from './events.js';
import { canRead, canWrite } from './permissions.js';

interface DocumentRow {
  id: string;
  room_id: string;
  filename: string;
  mime_type: string;
  byte_size: string | number;
  storage_key: string;
  checksum: string;
  uploaded_by: string;
  created_at: Date;
  extraction_status: ExtractionStatus;
  extraction_error: string | null;
  extraction_warnings: string[];
  page_count: number | null;
  chunk_count: number;
  summary: string | null;
  deleted_at: Date | null;
  purge_after: Date | null;
}

const DOCUMENT_COLUMNS = `id, room_id, filename, mime_type, byte_size, storage_key, checksum,
                          uploaded_by, created_at, extraction_status, extraction_error,
                          extraction_warnings, page_count, chunk_count, summary,
                          deleted_at, purge_after`;

function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id as DocumentId,
    roomId: row.room_id as RoomId,
    filename: row.filename,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    checksum: row.checksum,
    uploadedBy: row.uploaded_by as PersonId,
    createdAt: row.created_at,
    extraction: row.extraction_status,
    extractionError: row.extraction_error,
    warnings: row.extraction_warnings ?? [],
    pageCount: row.page_count,
    chunkCount: row.chunk_count,
    summary: row.summary,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
  };
}

export class PgDocuments implements DocumentPort {
  constructor(
    private readonly pool: Pool,
    private readonly llm: LlmPort,
    private readonly projection: ProjectionPort,
    private readonly jobs: JobPort,
    private readonly blobs: BlobStore,
    private readonly ledger: StorageLedger,
  ) {}

  async upload(
    actor: Actor,
    input: { roomId: RoomId; filename: string; mimeType: string; bytes: Uint8Array },
  ): Promise<{ documentId: DocumentId; extraction: ExtractionStatus; chunkCount: number }> {
    // Permission first, before a byte is written. Authorized by what the token can do,
    // never by anything found inside the file.
    if (!(await canWrite(this.pool, actor.personId, input.roomId))) throw new NotPermittedError();

    /**
     * The reservation, recorded as it is made.
     *
     * The charge against a person's ten gigabytes happens before the document row can
     * exist — the key is the checksum, so the bytes have to be written before anything
     * about them is knowable. What was missing was any record of *why* the charge was
     * made: if the transaction below then failed, the person had paid for an object they
     * could never see, and nothing would ever notice.
     *
     * `app.blob_upload` is that record, and it is what makes the failure survivable rather
     * than merely handled: compensation in this process cannot run when the process is
     * what died, and a leftover row here is something the reconciliation job can act on
     * after the restart.
     */
    let uploadId: string | null = null;
    let deduplicated = false;

    const { stored, extraction, chunks } = await ingestDocument({
      blobs: this.blobs,
      bytes: input.bytes,
      filename: input.filename,
      mimeType: input.mimeType,
      reserve: async (blob) => {
        const result = await this.ledger.reserve({
          personId: actor.personId,
          checksum: blob.checksum,
          byteSize: blob.byteSize,
          storageKey: blob.key,
        });
        if (!result.allowed) {
          throw storageLimitReached({
            filename: input.filename,
            byteSize: blob.byteSize,
            usage: result,
          });
        }

        deduplicated = result.deduplicated;
        const row = await queryOne<{ id: string }>(
          this.pool,
          `INSERT INTO app.blob_upload
             (person_id, room_id, checksum, storage_key, byte_size, filename, deduplicated)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            actor.personId,
            input.roomId,
            blob.checksum,
            blob.key,
            blob.byteSize,
            input.filename,
            result.deduplicated,
          ],
        );
        uploadId = row!.id;
      },
    });

    try {
      // The row and its chunks in one transaction. A document whose chunks half-landed is
      // a document that is partially searchable, which is worse than one that is not
      // searchable at all: nothing reports an error and the gap is invisible.
      //
      // The upload record is cleared in the same transaction, so "charged" and "has a
      // document" become true together and there is no window where they disagree.
      const documentId = await withTransaction(this.pool, async (tx) => {
        const row = await queryOne<{ id: string }>(
          tx,
          `INSERT INTO app.document
             (room_id, filename, mime_type, byte_size, storage_key, checksum, uploaded_by,
              text, extraction_status, extraction_error, extraction_warnings, extractor,
              page_count, chunk_count, extracted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, now())
           RETURNING id`,
          [
            input.roomId,
            input.filename,
            input.mimeType,
            input.bytes.byteLength,
            stored.key,
            stored.checksum,
            actor.personId,
            extraction.text.length > 0 ? extraction.text : null,
            extraction.outcome,
            extraction.error,
            JSON.stringify(extraction.warnings),
            extraction.extractor,
            extraction.pageCount,
            chunks.length,
          ],
        );
        const id = row!.id as DocumentId;

        for (const chunk of chunks) {
          await tx.query(
            `INSERT INTO app.chunk (document_id, room_id, ord, text, heading, token_estimate)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, input.roomId, chunk.ord, chunk.text, chunk.heading, chunk.tokenEstimate],
          );
          // `chunk.embedding` is null and deliberately not written. Chunking at ingest is
          // what makes turning embeddings on a backfill of one column rather than a
          // re-extraction of every document ever uploaded.
        }

        if (uploadId) {
          await tx.query('DELETE FROM app.blob_upload WHERE id = $1', [uploadId]);
        }

        return id;
      });

      uploadId = null;

      await appendEvent(this.pool, {
        roomId: input.roomId,
        eventType: 'document.uploaded',
        payload: {
          document_id: documentId,
          filename: input.filename,
          chunks: chunks.length,
          extraction: extraction.outcome,
        },
        actorPersonId: actor.personId,
        agentClient: actor.agentClient,
      });

      // Only worth summarising something we could read. Queueing a model call for a
      // scanned PDF would spend money to summarise nothing.
      if (chunks.length > 0) {
        await this.jobs.enqueue({
          kind: 'summarise_document',
          payload: { documentId },
          dedupeKey: `summarise:${documentId}`,
        });
      }
      await this.projection.invalidate({ roomId: input.roomId });

      return { documentId, extraction: extraction.outcome, chunkCount: chunks.length };
    } catch (error) {
      // Compensation, for the failure this process is still alive to see: give the space
      // back, and delete the bytes if nothing else references them. Without it a transient
      // error left a person paying for an invisible object and an original with no memory
      // pointing at it — which is the same thing reconciliation cleans up later, only
      // sooner and without a person having to wonder where their gigabyte went.
      await this.releaseUpload({
        uploadId,
        personId: actor.personId,
        checksum: stored.checksum,
        storageKey: stored.key,
        deduplicated,
      }).catch(() => undefined);

      throw error;
    }
  }

  /**
   * Undoes a reservation: the ledger row, the upload record and, if it is safe, the bytes.
   *
   * "Safe" is the whole difficulty. Storage is content-addressed, so one object can be
   * referenced by several people's documents and several people's ledger rows, and
   * deleting it because *this* upload failed would break somebody else's document. So the
   * question asked is not "is this person done with it" but "is anyone using it at all",
   * and it is asked in SQL rather than assembled here.
   */
  private async releaseUpload(input: {
    uploadId: string | null;
    personId: PersonId;
    checksum: string;
    storageKey: string;
    /** These bytes were already on the account: the charge was a ref count, not a purchase. */
    deduplicated: boolean;
  }): Promise<void> {
    if (input.uploadId) {
      await this.pool.query('DELETE FROM app.blob_upload WHERE id = $1', [input.uploadId]);
    }

    await this.ledger.release({ personId: input.personId, checksum: input.checksum });

    // A deduplicated upload's bytes belong to a document that was already there. Releasing
    // the reference is the whole compensation; deleting the object would take that
    // document's original with it.
    if (input.deduplicated) return;

    const orphan = await queryOne<{ unreferenced: boolean }>(
      this.pool,
      `SELECT app.blob_is_unreferenced($1) AS unreferenced`,
      [input.checksum],
    );
    if (orphan?.unreferenced) await this.blobs.delete(input.storageKey);
  }

  async get(actor: Actor, documentId: DocumentId): Promise<DocumentSummary | null> {
    // Membership resolved in the query rather than by fetching the row and filtering it
    // in TypeScript — the same rule every read path here follows.
    //
    // A document in the trash reads as absent, like a deleted memory does. `trashed()` is
    // where it can still be seen, and `restore` is how it comes back.
    const row = await queryOne<DocumentRow>(
      this.pool,
      `SELECT ${DOCUMENT_COLUMNS} FROM app.document d
       WHERE d.id = $1 AND d.deleted_at IS NULL AND app.can_read_room($2, d.room_id)`,
      [documentId, actor.personId],
    );
    return row ? toSummary(row) : null;
  }

  async listForRoom(actor: Actor, roomId: RoomId): Promise<DocumentSummary[]> {
    if (!(await canRead(this.pool, actor.personId, roomId))) throw new NotPermittedError();

    const rows = await queryRows<DocumentRow>(
      this.pool,
      `SELECT ${DOCUMENT_COLUMNS} FROM app.document
       WHERE room_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [roomId],
    );
    return rows.map(toSummary);
  }

  async chunksFor(
    actor: Actor,
    documentId: DocumentId,
  ): Promise<Array<{ id: ChunkId; ord: number; text: string }>> {
    const rows = await queryRows<{ id: string; ord: number; text: string }>(
      this.pool,
      `SELECT c.id, c.ord, c.text FROM app.chunk c
       JOIN app.document d ON d.id = c.document_id
       WHERE c.document_id = $1 AND d.deleted_at IS NULL AND app.can_read_room($2, d.room_id)
       ORDER BY c.ord ASC`,
      [documentId, actor.personId],
    );

    if (rows.length === 0) {
      // Could be an unreachable document or one with no text. Both answer the same way:
      // a caller must not be able to tell "exists but not yours" from "does not exist".
      const exists = await this.get(actor, documentId);
      if (!exists) throw new NotPermittedError();
    }

    return rows.map((r) => ({ id: r.id as ChunkId, ord: r.ord, text: r.text }));
  }

  async originalText(actor: Actor, documentId: DocumentId): Promise<string | null> {
    const row = await queryOne<{ text: string | null }>(
      this.pool,
      `SELECT d.text FROM app.document d
       WHERE d.id = $1 AND d.deleted_at IS NULL AND app.can_read_room($2, d.room_id)`,
      [documentId, actor.personId],
    );
    return row?.text ?? null;
  }

  async download(
    actor: Actor,
    documentId: DocumentId,
  ): Promise<{ filename: string; mimeType: string; bytes: Uint8Array } | null> {
    const row = await queryOne<{ filename: string; mime_type: string; storage_key: string }>(
      this.pool,
      `SELECT d.filename, d.mime_type, d.storage_key FROM app.document d
       WHERE d.id = $1 AND d.deleted_at IS NULL AND app.can_read_room($2, d.room_id)`,
      [documentId, actor.personId],
    );
    if (!row) return null;

    try {
      return {
        filename: row.filename,
        mimeType: row.mime_type,
        bytes: await this.blobs.get(row.storage_key),
      };
    } catch (error) {
      // The row says the file exists and the store says it does not. Worth an explicit
      // error rather than a null: a null reads as "no such document", and this is a
      // storage inconsistency someone needs to know about.
      if (error instanceof NotFoundError) {
        throw new NotFoundError(
          `Filen "${row.filename}" finns registrerad men saknas i lagringen.`,
        );
      }
      throw error;
    }
  }

  async storageUsage(actor: Actor): Promise<StorageUsageReport> {
    return this.ledger.usage(actor.personId);
  }

  /**
   * Moves a document to the trash, with the same thirty days a memory gets.
   *
   * Deliberately not a hard delete and deliberately not a second deletion path: the
   * product's promise is that deleting is reversible, and a document is memory. The event
   * is appended so the room's history shows that a file was removed, by whom — other
   * members seeing a document disappear with no trace is the silent removal the log exists
   * to prevent.
   *
   * The storage charge stays until the purge. A restore that could fail at the storage
   * limit would make the trash a promise we cannot keep.
   */
  async remove(
    actor: Actor,
    documentId: DocumentId,
    options: { reason?: string } = {},
  ): Promise<DocumentSummary | null> {
    const existing = await this.get(actor, documentId);
    if (!existing) return null;
    if (!(await canWrite(this.pool, actor.personId, existing.roomId))) throw new NotPermittedError();

    const row = await queryOne<DocumentRow>(
      this.pool,
      `UPDATE app.document
       SET deleted_at = now(),
           deleted_by = $2,
           deleted_by_client = $3,
           purge_after = now() + ($4 || ' days')::interval
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING ${DOCUMENT_COLUMNS}`,
      [documentId, actor.personId, actor.agentClient, TRASH_RETENTION_DAYS],
    );
    if (!row) return null;

    await appendEvent(this.pool, {
      roomId: existing.roomId,
      eventType: 'document.deleted',
      payload: {
        document_id: documentId,
        filename: existing.filename,
        purge_after: row.purge_after?.toISOString() ?? null,
        ...(options.reason ? { reason: options.reason } : {}),
      },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      motivation: `Dokumentet ligger i papperskorgen i ${TRASH_RETENTION_DAYS} dagar och går att ta tillbaka.`,
    });

    await this.projection.invalidate({ roomId: existing.roomId });
    return toSummary(row);
  }

  async restore(actor: Actor, documentId: DocumentId): Promise<DocumentSummary | null> {
    // Read straight from the table rather than through `get`, which hides the trash. The
    // permission check is the same one a delete needs: restoring puts a file back where
    // other members can read it.
    const trashed = await queryOne<DocumentRow>(
      this.pool,
      `SELECT ${DOCUMENT_COLUMNS} FROM app.document d
       WHERE d.id = $1 AND d.deleted_at IS NOT NULL AND app.can_read_room($2, d.room_id)`,
      [documentId, actor.personId],
    );
    if (!trashed) return null;
    if (!(await canWrite(this.pool, actor.personId, trashed.room_id as RoomId))) {
      throw new NotPermittedError();
    }

    const row = await queryOne<DocumentRow>(
      this.pool,
      `UPDATE app.document
       SET deleted_at = NULL, deleted_by = NULL, deleted_by_client = NULL, purge_after = NULL
       WHERE id = $1 AND deleted_at IS NOT NULL
       RETURNING ${DOCUMENT_COLUMNS}`,
      [documentId],
    );
    if (!row) return null;

    await appendEvent(this.pool, {
      roomId: row.room_id as RoomId,
      eventType: 'document.restored',
      payload: { document_id: documentId, filename: row.filename },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    await this.projection.invalidate({ roomId: row.room_id as RoomId });
    return toSummary(row);
  }

  async trashed(
    actor: Actor,
    input: { roomId?: RoomId; limit?: number } = {},
  ): Promise<DocumentSummary[]> {
    if (input.roomId && !(await canRead(this.pool, actor.personId, input.roomId))) {
      // Not-found rather than forbidden, like every other denial here.
      return [];
    }

    const rows = await queryRows<DocumentRow>(
      this.pool,
      `SELECT ${DOCUMENT_COLUMNS} FROM app.document d
       WHERE d.deleted_at IS NOT NULL
         AND app.can_read_room($1, d.room_id)
         AND ($2::uuid IS NULL OR d.room_id = $2::uuid)
       ORDER BY d.deleted_at DESC
       LIMIT $3`,
      [actor.personId, input.roomId ?? null, input.limit ?? 50],
    );
    return rows.map(toSummary);
  }

  /**
   * Deletes documents whose thirty days are up: chunks, row, storage charge, bytes.
   *
   * In that order and not the other way round. A blob deleted before its row would leave a
   * document that lists and refuses to download, which is the failure mode the export's
   * "missing from storage" note exists for — worth avoiding rather than tolerating.
   */
  async purgeExpired(limit = 100): Promise<number> {
    const due = await queryRows<{
      id: string;
      room_id: string;
      checksum: string;
      storage_key: string;
      uploaded_by: string;
      filename: string;
    }>(
      this.pool,
      `SELECT id, room_id, checksum, storage_key, uploaded_by, filename FROM app.document
       WHERE deleted_at IS NOT NULL AND purge_after <= now()
       ORDER BY purge_after
       LIMIT $1`,
      [limit],
    );

    let purged = 0;

    for (const doc of due) {
      await withTransaction(this.pool, async (tx) => {
        await tx.query('DELETE FROM app.chunk WHERE document_id = $1', [doc.id]);
        await tx.query('DELETE FROM app.document WHERE id = $1', [doc.id]);
      });

      // Now that the row is gone, the space goes back and the bytes go if nobody else
      // references them.
      await this.releaseUpload({
        uploadId: null,
        personId: doc.uploaded_by as PersonId,
        checksum: doc.checksum,
        storageKey: doc.storage_key,
        deduplicated: false,
      }).catch(() => undefined);

      await appendEvent(this.pool, {
        roomId: doc.room_id as RoomId,
        eventType: 'document.purged',
        payload: { document_id: doc.id, filename: doc.filename },
        actorPersonId: doc.uploaded_by as PersonId,
        agentClient: 'web',
        motivation: `${TRASH_RETENTION_DAYS} dagar gick. Filen är permanent raderad.`,
      });

      await this.projection.invalidate({ roomId: doc.room_id as RoomId });
      purged += 1;
    }

    return purged;
  }

  /**
   * Finds storage nobody is using and gives it back.
   *
   * Two kinds, both of them the same accident seen from different distances. An upload
   * whose process died left a `blob_upload` row and a charge with no document; an upload
   * that died before any of this existed left only the charge. Neither can be found by
   * looking at documents, which is the point — they are invisible by construction, and a
   * person's ten gigabytes was quietly smaller than it said.
   *
   * The grace periods are what keep this from eating live work. An upload in flight has a
   * `blob_upload` row and no document *right now*, and it is indistinguishable from a
   * crashed one except by age.
   */
  async reconcileStorage(
    options: { uploadGraceMinutes?: number; ledgerGraceHours?: number; limit?: number } = {},
  ): Promise<{ uploadsReleased: number; objectsReleased: number; blobsDeleted: number }> {
    const uploadGrace = options.uploadGraceMinutes ?? 30;
    const ledgerGrace = options.ledgerGraceHours ?? 24;
    const limit = options.limit ?? 100;

    let uploadsReleased = 0;
    let objectsReleased = 0;
    let blobsDeleted = 0;

    const abandoned = await queryRows<{
      id: string;
      person_id: string;
      checksum: string;
      storage_key: string;
      deduplicated: boolean;
    }>(
      this.pool,
      `SELECT u.id, u.person_id, u.checksum, u.storage_key, u.deduplicated
       FROM app.blob_upload u
       WHERE u.created_at < now() - ($1 || ' minutes')::interval
         AND NOT EXISTS (
           SELECT 1 FROM app.document d
           WHERE d.checksum = u.checksum AND d.uploaded_by = u.person_id
         )
       ORDER BY u.created_at
       LIMIT $2`,
      [uploadGrace, limit],
    );

    for (const upload of abandoned) {
      const before = await this.blobs.exists(upload.storage_key);
      await this.releaseUpload({
        uploadId: upload.id,
        personId: upload.person_id as PersonId,
        checksum: upload.checksum,
        storageKey: upload.storage_key,
        deduplicated: upload.deduplicated,
      });
      uploadsReleased += 1;
      if (before && !(await this.blobs.exists(upload.storage_key))) blobsDeleted += 1;
    }

    // A `blob_upload` row whose document *does* exist is one the upload path failed to
    // clear — the document is fine, so this is bookkeeping rather than compensation.
    await this.pool.query(
      `DELETE FROM app.blob_upload u
       WHERE u.created_at < now() - ($1 || ' minutes')::interval
         AND EXISTS (
           SELECT 1 FROM app.document d
           WHERE d.checksum = u.checksum AND d.uploaded_by = u.person_id
         )`,
      [uploadGrace],
    );

    const orphans = await queryRows<{
      person_id: string;
      checksum: string;
      storage_key: string;
    }>(
      this.pool,
      `SELECT person_id, checksum, storage_key
       FROM app.orphaned_storage_objects(($1 || ' hours')::interval, $2)`,
      [ledgerGrace, limit],
    );

    for (const orphan of orphans) {
      const before = await this.blobs.exists(orphan.storage_key);
      await this.releaseUpload({
        uploadId: null,
        personId: orphan.person_id as PersonId,
        checksum: orphan.checksum,
        storageKey: orphan.storage_key,
        deduplicated: false,
      });
      objectsReleased += 1;
      if (before && !(await this.blobs.exists(orphan.storage_key))) blobsDeleted += 1;
    }

    return { uploadsReleased, objectsReleased, blobsDeleted };
  }

  /** Called by the `summarise_document` job rather than on the upload path. */
  async summarise(documentId: DocumentId): Promise<void> {
    const doc = await queryOne<{ room_id: string }>(
      this.pool,
      `SELECT room_id FROM app.document WHERE id = $1`,
      [documentId],
    );
    if (!doc) return;

    const rows = await queryRows<{ text: string }>(
      this.pool,
      `SELECT text FROM app.chunk WHERE document_id = $1 ORDER BY ord ASC`,
      [documentId],
    );
    if (rows.length === 0) return;

    const summary = await this.llm.summarise({
      texts: rows.map((r) => r.text),
      budgetTokens: 120,
    });

    // Writes `summary` and never `text`. The extraction is the source and a model's
    // paraphrase must not be able to overwrite it.
    await this.pool.query(`UPDATE app.document SET summary = $1 WHERE id = $2`, [
      summary,
      documentId,
    ]);
    await this.projection.invalidate({ roomId: doc.room_id as RoomId });
  }
}

export { CHUNK_CHARS, CHUNK_OVERLAP, chunkText } from '@photographic/documents';
export const MAX_BYTES = 25 * 1024 * 1024;
