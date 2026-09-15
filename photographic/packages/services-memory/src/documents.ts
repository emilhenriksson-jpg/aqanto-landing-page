/**
 * Documents.
 *
 * A document is not a memory and is deliberately not treated as one. Memories are
 * small, curated and injected whole; documents are large, uncurated and retrieved in
 * pieces. Blurring the two is how a PDF ends up occupying the profile that every model
 * reads on every session.
 *
 * Extraction, chunking, the storage limit and the order the steps happen in all live in
 * `@photographic/documents`, and `PgDocuments` calls the same pipeline. What is left
 * here is the part that genuinely differs between backends: where the rows go.
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
  ProjectionPort,
  RoomId,
  StorageUsageReport,
} from '@photographic/core';
import { NotPermittedError } from '@photographic/core';
import type { BlobStore, StorageLedger } from '@photographic/documents';
import { ingestDocument, storageLimitReached } from '@photographic/documents';
import { MemoryBlobStore, MemoryStorageLedger } from '@photographic/documents/testing';

import { MemoryStore, newId } from './store.js';

export class MemoryDocuments implements DocumentPort {
  private readonly blobs: BlobStore;
  private readonly ledger: StorageLedger;

  constructor(
    private readonly store: MemoryStore,
    private readonly llm: LlmPort,
    private readonly projection: ProjectionPort,
    private readonly jobs: JobPort,
    options: { blobs?: BlobStore; ledger?: StorageLedger } = {},
  ) {
    // Real implementations of both interfaces rather than stubs — `MemoryBlobStore`
    // genuinely deduplicates by checksum and `MemoryStorageLedger` genuinely enforces
    // the limit — so this driver exercises the same behaviour the Postgres one does.
    this.blobs = options.blobs ?? new MemoryBlobStore();
    this.ledger = options.ledger ?? new MemoryStorageLedger();
  }

  async upload(
    actor: Actor,
    input: { roomId: RoomId; filename: string; mimeType: string; bytes: Uint8Array },
  ): Promise<{ documentId: DocumentId; extraction: ExtractionStatus; chunkCount: number }> {
    // Permission first, before a byte is written. Authorized by what the token can do,
    // never by anything found inside the file.
    if (!this.store.canWrite(actor.personId, input.roomId)) throw new NotPermittedError();

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

    const documentId = newId<DocumentId>();
    const now = this.store.now();

    this.store.documents.set(documentId, {
      id: documentId,
      roomId: input.roomId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      storageKey: stored.key,
      checksum: stored.checksum,
      // Our extraction. Never overwritten by the summariser — `summary` is its own
      // field so the source stays reachable.
      text: extraction.text,
      extraction: extraction.outcome,
      extractionError: extraction.error,
      warnings: extraction.warnings,
      pageCount: extraction.pageCount,
      summary: null,
      uploadedBy: actor.personId,
      uploadedAt: now,
    });

    for (const chunk of chunks) {
      const id = newId<ChunkId>();
      this.store.chunks.set(id, {
        id,
        documentId,
        roomId: input.roomId,
        ord: chunk.ord,
        text: chunk.text,
        heading: chunk.heading,
        // Null on purpose, and the same on both drivers: chunking at ingest is what
        // makes adding embeddings a backfill rather than a re-extraction.
        embedding: null,
      });
    }

    this.store.append({
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
    // scanned PDF would spend money to produce a summary of nothing.
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
    const doc = this.store.documents.get(documentId);
    if (!doc || !this.store.canRead(actor.personId, doc.roomId)) return null;
    return summarise(doc, this.chunkCountOf(documentId));
  }

  async listForRoom(actor: Actor, roomId: RoomId): Promise<DocumentSummary[]> {
    if (!this.store.canRead(actor.personId, roomId)) throw new NotPermittedError();
    return [...this.store.documents.values()]
      .filter((d) => d.roomId === roomId)
      .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
      .map((d) => summarise(d, this.chunkCountOf(d.id)));
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

  async originalText(actor: Actor, documentId: DocumentId): Promise<string | null> {
    const doc = this.store.documents.get(documentId);
    if (!doc || !this.store.canRead(actor.personId, doc.roomId)) return null;
    return doc.text.length > 0 ? doc.text : null;
  }

  async download(
    actor: Actor,
    documentId: DocumentId,
  ): Promise<{ filename: string; mimeType: string; bytes: Uint8Array } | null> {
    const doc = this.store.documents.get(documentId);
    if (!doc || !this.store.canRead(actor.personId, doc.roomId)) return null;

    return {
      filename: doc.filename,
      mimeType: doc.mimeType,
      bytes: await this.blobs.get(doc.storageKey),
    };
  }

  async storageUsage(actor: Actor): Promise<StorageUsageReport> {
    return this.ledger.usage(actor.personId);
  }

  /** Called by the `summarise_document` job rather than on the upload path. */
  async summarise(documentId: DocumentId): Promise<void> {
    const doc = this.store.documents.get(documentId);
    if (!doc) return;

    const pieces = [...this.store.chunks.values()]
      .filter((c) => c.documentId === documentId)
      .sort((a, b) => a.ord - b.ord)
      .map((c) => c.text);
    if (pieces.length === 0) return;

    doc.summary = await this.llm.summarise({ texts: pieces, budgetTokens: 120 });
    await this.projection.invalidate({ roomId: doc.roomId });
  }

  private chunkCountOf(documentId: DocumentId): number {
    let count = 0;
    for (const chunk of this.store.chunks.values()) {
      if (chunk.documentId === documentId) count += 1;
    }
    return count;
  }
}

function summarise(
  doc: {
    id: DocumentId;
    roomId: RoomId;
    filename: string;
    mimeType: string;
    byteSize: number;
    checksum: string;
    extraction: ExtractionStatus;
    extractionError: string | null;
    warnings: string[];
    pageCount: number | null;
    summary: string | null;
    uploadedBy: Actor['personId'];
    uploadedAt: Date;
  },
  chunkCount: number,
): DocumentSummary {
  return {
    id: doc.id,
    roomId: doc.roomId,
    filename: doc.filename,
    mimeType: doc.mimeType,
    byteSize: doc.byteSize,
    checksum: doc.checksum,
    uploadedBy: doc.uploadedBy,
    createdAt: doc.uploadedAt,
    extraction: doc.extraction,
    extractionError: doc.extractionError,
    warnings: doc.warnings,
    pageCount: doc.pageCount,
    chunkCount,
    summary: doc.summary,
  };
}

export { CHUNK_CHARS, CHUNK_OVERLAP, chunkText } from '@photographic/documents';
