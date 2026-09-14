/**
 * Documents.
 *
 * A document is not a memory and is deliberately not treated as one. Memories are
 * small, curated and injected whole; documents are large, uncurated and retrieved in
 * pieces. Blurring the two is how a PDF ends up occupying the profile that every model
 * reads on every session.
 *
 * Text extraction lives in `@photographic/documents`. This takes already-decoded text,
 * because the parsing of a given format has nothing to do with the storage model and
 * pulling a parser in here would make the reference implementation depend on it.
 */

import type {
  Actor,
  ChunkId,
  DocumentId,
  DocumentPort,
  JobPort,
  LlmPort,
  ProjectionPort,
  RoomId,
} from '@photographic/core';
import { NotPermittedError, ValidationError } from '@photographic/core';

import { MemoryStore, newId } from './store.js';

/** Target chunk size. Small enough to be a precise citation, large enough to mean something. */
export const CHUNK_CHARS = 1200;
export const CHUNK_OVERLAP = 150;

export const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Splits on paragraph boundaries where it can, with a character cap as the fallback.
 *
 * The overlap exists because the sentence answering a question is often the one
 * straddling a boundary, and a chunk that begins mid-argument retrieves poorly.
 */
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

export class MemoryDocuments implements DocumentPort {
  constructor(
    private readonly store: MemoryStore,
    private readonly llm: LlmPort,
    private readonly projection: ProjectionPort,
    private readonly jobs: JobPort,
  ) {}

  async upload(
    actor: Actor,
    input: { roomId: RoomId; filename: string; mimeType: string; bytes: Uint8Array },
  ): Promise<{ documentId: DocumentId }> {
    if (!this.store.canWrite(actor.personId, input.roomId)) throw new NotPermittedError();
    if (input.bytes.byteLength > MAX_BYTES) throw new ValidationError('Filen är för stor.');

    const text = new TextDecoder().decode(input.bytes);
    const documentId = newId<DocumentId>();

    this.store.documents.set(documentId, {
      id: documentId,
      roomId: input.roomId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      text,
      summary: null,
      uploadedBy: actor.personId,
      uploadedAt: this.store.now(),
    });

    const pieces = chunkText(text);
    const vectors = pieces.length > 0 ? await this.llm.embed(pieces) : [];

    pieces.forEach((piece, ord) => {
      const id = newId<ChunkId>();
      this.store.chunks.set(id, {
        id,
        documentId,
        roomId: input.roomId,
        ord,
        text: piece,
        embedding: vectors[ord] ?? null,
      });
    });

    this.store.append({
      roomId: input.roomId,
      eventType: 'document.uploaded',
      payload: { document_id: documentId, filename: input.filename, chunks: pieces.length },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    // The summary is what makes a document visible in a room brief without pulling the
    // whole thing in, and it costs a model call, so it happens out of band.
    await this.jobs.enqueue({
      kind: 'summarise_document',
      payload: { documentId },
      dedupeKey: `summarise:${documentId}`,
    });
    await this.projection.invalidate({ roomId: input.roomId });

    return { documentId };
  }

  async get(
    actor: Actor,
    documentId: DocumentId,
  ): Promise<{ filename: string; summary: string | null } | null> {
    const doc = this.store.documents.get(documentId);
    if (!doc || !this.store.canRead(actor.personId, doc.roomId)) return null;
    return { filename: doc.filename, summary: doc.summary };
  }

  async listForRoom(
    actor: Actor,
    roomId: RoomId,
  ): Promise<Array<{ id: DocumentId; filename: string }>> {
    if (!this.store.canRead(actor.personId, roomId)) throw new NotPermittedError();
    return [...this.store.documents.values()]
      .filter((d) => d.roomId === roomId)
      .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
      .map((d) => ({ id: d.id, filename: d.filename }));
  }

  async chunksFor(
    actor: Actor,
    documentId: DocumentId,
  ): Promise<Array<{ id: ChunkId; ord: number; text: string }>> {
    const doc = this.store.documents.get(documentId);
    if (!doc || !this.store.canRead(actor.personId, doc.roomId)) throw new NotPermittedError();

    return [...this.store.chunks.values()]
      .filter((c) => c.documentId === documentId)
      .sort((a, b) => a.ord - b.ord)
      .map((c) => ({ id: c.id, ord: c.ord, text: c.text }));
  }

  /** Called by the `summarise_document` job rather than on the upload path. */
  async summarise(documentId: DocumentId): Promise<void> {
    const doc = this.store.documents.get(documentId);
    if (!doc) return;

    const pieces = [...this.store.chunks.values()]
      .filter((c) => c.documentId === documentId)
      .sort((a, b) => a.ord - b.ord)
      .map((c) => c.text);

    doc.summary = await this.llm.summarise({ texts: pieces, budgetTokens: 120 });
    await this.projection.invalidate({ roomId: doc.roomId });
  }
}
