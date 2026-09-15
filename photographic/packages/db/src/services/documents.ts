/**
 * Documents, backed by Postgres. See `MemoryDocuments` for the chunking rationale.
 *
 * `app.document` has no column for the raw text -- that lives wherever the object
 * storage this schema assumes puts it, which does not exist yet. `storage_key` and
 * `checksum` are filled with placeholders that make that gap visible rather than
 * silently wrong; the chunk text itself, which is what search and the brief actually
 * read, is stored for real.
 */

import { createHash } from 'node:crypto';

import type { Actor, ChunkId, DocumentId, DocumentPort, JobPort, LlmPort, ProjectionPort, RoomId } from '@photographic/core';
import { NotPermittedError, ValidationError } from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows } from '../pool.js';
import { appendEvent } from './events.js';
import { canRead, canWrite } from './permissions.js';

export const CHUNK_CHARS = 1200;
export const CHUNK_OVERLAP = 150;
export const MAX_BYTES = 25 * 1024 * 1024;

export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < clean.length) {
    const end = Math.min(cursor + size, clean.length);
    let cut = end;

    if (end < clean.length) {
      const paragraph = clean.lastIndexOf('\n\n', end);
      const sentence = clean.lastIndexOf('. ', end);
      const candidate = Math.max(paragraph, sentence);
      if (candidate > cursor + size / 2) cut = candidate + 1;
    }

    const piece = clean.slice(cursor, cut).trim();
    if (piece) chunks.push(piece);
    if (cut >= clean.length) break;
    cursor = Math.max(cut - overlap, cursor + 1);
  }

  return chunks;
}

export class PgDocuments implements DocumentPort {
  constructor(
    private readonly pool: Pool,
    private readonly llm: LlmPort,
    private readonly projection: ProjectionPort,
    private readonly jobs: JobPort,
  ) {}

  async upload(
    actor: Actor,
    input: { roomId: RoomId; filename: string; mimeType: string; bytes: Uint8Array },
  ): Promise<{ documentId: DocumentId }> {
    if (!(await canWrite(this.pool, actor.personId, input.roomId))) throw new NotPermittedError();
    if (input.bytes.byteLength > MAX_BYTES) throw new ValidationError('Filen är för stor.');

    const text = new TextDecoder().decode(input.bytes);
    const checksum = createHash('sha256').update(input.bytes).digest('hex');

    const row = await queryOne<{ id: string }>(
      this.pool,
      `INSERT INTO app.document (room_id, filename, mime_type, byte_size, storage_key, checksum, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [input.roomId, input.filename, input.mimeType, input.bytes.byteLength, `inline:${checksum}`, checksum, actor.personId],
    );
    const documentId = row!.id as DocumentId;

    const pieces = chunkText(text);
    const vectors = pieces.length > 0 ? await this.llm.embed(pieces) : [];

    for (const [ord, piece] of pieces.entries()) {
      await this.pool.query(
        `INSERT INTO app.chunk (document_id, room_id, ord, text, token_estimate)
         VALUES ($1, $2, $3, $4, $5)`,
        [documentId, input.roomId, ord, piece, Math.ceil(piece.length / 3.6)],
      );
      // `vectors[ord]` is intentionally not persisted yet -- see `PgRetrieval`'s file
      // comment on `chunk.embedding` not being wired in.
      void vectors[ord];
    }

    await appendEvent(this.pool, {
      roomId: input.roomId,
      eventType: 'document.uploaded',
      payload: { document_id: documentId, filename: input.filename, chunks: pieces.length },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    await this.jobs.enqueue({
      kind: 'summarise_document',
      payload: { documentId },
      dedupeKey: `summarise:${documentId}`,
    });
    await this.projection.invalidate({ roomId: input.roomId });

    return { documentId };
  }

  async get(actor: Actor, documentId: DocumentId): Promise<{ filename: string; summary: string | null } | null> {
    const row = await queryOne<{ filename: string; summary: string | null; room_id: string }>(
      this.pool,
      `SELECT filename, summary, room_id FROM app.document WHERE id = $1`,
      [documentId],
    );
    if (!row || !(await canRead(this.pool, actor.personId, row.room_id as RoomId))) return null;
    return { filename: row.filename, summary: row.summary };
  }

  async listForRoom(actor: Actor, roomId: RoomId): Promise<Array<{ id: DocumentId; filename: string }>> {
    if (!(await canRead(this.pool, actor.personId, roomId))) throw new NotPermittedError();
    const rows = await queryRows<{ id: string; filename: string }>(
      this.pool,
      `SELECT id, filename FROM app.document WHERE room_id = $1 ORDER BY created_at DESC`,
      [roomId],
    );
    return rows.map((r) => ({ id: r.id as DocumentId, filename: r.filename }));
  }

  async chunksFor(actor: Actor, documentId: DocumentId): Promise<Array<{ id: ChunkId; ord: number; text: string }>> {
    const doc = await queryOne<{ room_id: string }>(this.pool, `SELECT room_id FROM app.document WHERE id = $1`, [
      documentId,
    ]);
    if (!doc || !(await canRead(this.pool, actor.personId, doc.room_id as RoomId))) throw new NotPermittedError();

    const rows = await queryRows<{ id: string; ord: number; text: string }>(
      this.pool,
      `SELECT id, ord, text FROM app.chunk WHERE document_id = $1 ORDER BY ord ASC`,
      [documentId],
    );
    return rows.map((r) => ({ id: r.id as ChunkId, ord: r.ord, text: r.text }));
  }

  /** Called by the `summarise_document` job rather than on the upload path. */
  async summarise(documentId: DocumentId): Promise<void> {
    const doc = await queryOne<{ room_id: string }>(this.pool, `SELECT room_id FROM app.document WHERE id = $1`, [
      documentId,
    ]);
    if (!doc) return;

    const rows = await queryRows<{ text: string }>(
      this.pool,
      `SELECT text FROM app.chunk WHERE document_id = $1 ORDER BY ord ASC`,
      [documentId],
    );

    const summary = await this.llm.summarise({ texts: rows.map((r) => r.text), budgetTokens: 120 });
    await this.pool.query(`UPDATE app.document SET summary = $1 WHERE id = $2`, [summary, documentId]);
    await this.projection.invalidate({ roomId: doc.room_id as RoomId });
  }
}
