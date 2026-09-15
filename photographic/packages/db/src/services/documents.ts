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
import { NotFoundError, NotPermittedError } from '@photographic/core';
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
}

const DOCUMENT_COLUMNS = `id, room_id, filename, mime_type, byte_size, storage_key, checksum,
                          uploaded_by, created_at, extraction_status, extraction_error,
                          extraction_warnings, page_count, chunk_count, summary`;

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
      },
    });

    // The row and its chunks in one transaction. A document whose chunks half-landed is
    // a document that is partially searchable, which is worse than one that is not
    // searchable at all: nothing reports an error and the gap is invisible.
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

      return id;
    });

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
  }

  async get(actor: Actor, documentId: DocumentId): Promise<DocumentSummary | null> {
    // Membership resolved in the query rather than by fetching the row and filtering it
    // in TypeScript — the same rule every read path here follows.
    const row = await queryOne<DocumentRow>(
      this.pool,
      `SELECT ${DOCUMENT_COLUMNS} FROM app.document d
       WHERE d.id = $1 AND app.can_read_room($2, d.room_id)`,
      [documentId, actor.personId],
    );
    return row ? toSummary(row) : null;
  }

  async listForRoom(actor: Actor, roomId: RoomId): Promise<DocumentSummary[]> {
    if (!(await canRead(this.pool, actor.personId, roomId))) throw new NotPermittedError();

    const rows = await queryRows<DocumentRow>(
      this.pool,
      `SELECT ${DOCUMENT_COLUMNS} FROM app.document
       WHERE room_id = $1 ORDER BY created_at DESC`,
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
       WHERE c.document_id = $1 AND app.can_read_room($2, d.room_id)
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
       WHERE d.id = $1 AND app.can_read_room($2, d.room_id)`,
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
       WHERE d.id = $1 AND app.can_read_room($2, d.room_id)`,
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
