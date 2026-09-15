/**
 * Everything `@photographic/documents` needs from the outside world.
 *
 * Deliberately narrower than the ports in `@photographic/core`: this package is
 * written against these interfaces so it can be built and tested before
 * `@photographic/db` exists, and so the in-memory implementations in `./testing`
 * stay small enough to trust. A real repository from `@photographic/db` satisfies
 * each of these structurally; so does a full `LlmPort` for `DocumentLlm`.
 *
 * Note where permission lives. Read methods take `personId` and are expected to
 * resolve membership *inside the query* (`app.accessible_room_ids`), never by
 * fetching rows and filtering them in TypeScript. `RoomAccess` mirrors the two SQL
 * helpers `app.can_read_room` and `app.can_write_room` for the write path, where
 * there is no row to scope yet.
 */

import type { AgentClient, ChunkId, DocumentId, PersonId, RoomId } from '@photographic/core';

export type { BlobStore, StoredBlob } from './blob-store.js';

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** One row of `app.document`. */
export interface DocumentRecord {
  id: DocumentId;
  roomId: RoomId;
  filename: string;
  mimeType: string;
  byteSize: number;
  storageKey: string;
  checksum: string;
  uploadedBy: PersonId;
  extractedAt: Date | null;
  summary: string | null;
  createdAt: Date;
}

export interface NewDocument {
  roomId: RoomId;
  filename: string;
  mimeType: string;
  byteSize: number;
  storageKey: string;
  checksum: string;
  uploadedBy: PersonId;
}

export interface DocumentStore {
  insert(input: NewDocument): Promise<DocumentRecord>;

  /** Permission-scoped read. Resolves membership in the query; null means 404. */
  findReadable(personId: PersonId, documentId: DocumentId): Promise<DocumentRecord | null>;

  /** Permission-scoped list. Returns an empty array when the room is unreachable. */
  listReadableInRoom(personId: PersonId, roomId: RoomId): Promise<DocumentRecord[]>;

  /**
   * Unscoped read for the extraction job, which runs after upload already proved
   * write permission. Never reachable from a request path.
   */
  findById(documentId: DocumentId): Promise<DocumentRecord | null>;

  markExtracted(
    documentId: DocumentId,
    input: { summary: string | null; extractedAt: Date },
  ): Promise<void>;

  /**
   * Extraction failed but the bytes are safe. `extracted_at` stays null and the
   * Swedish explanation goes where the summary would have been, so the person sees
   * why rather than an empty card.
   */
  markExtractionFailed(documentId: DocumentId, input: { message: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

export interface NewChunk {
  documentId: DocumentId;
  roomId: RoomId;
  ord: number;
  text: string;
  tokenEstimate: number;
  embedding: number[] | null;
  /**
   * The heading this chunk sits under, when the source had one. `app.chunk` is
   * frozen and has no column for it, so the service also folds it into `text`;
   * a store that can keep it separately may.
   */
  heading: string | null;
}

export interface ChunkRecord {
  id: ChunkId;
  documentId: DocumentId;
  roomId: RoomId;
  ord: number;
  text: string;
  tokenEstimate: number;
}

export interface ChunkStore {
  /** Re-extraction replaces a document's chunks wholesale, in one transaction. */
  replaceForDocument(documentId: DocumentId, chunks: NewChunk[]): Promise<void>;

  /** Permission-scoped read, ordered by `ord`. */
  listReadable(personId: PersonId, documentId: DocumentId): Promise<ChunkRecord[]>;
}

// ---------------------------------------------------------------------------
// Permission, events, jobs, projections
// ---------------------------------------------------------------------------

/** `app.can_read_room` / `app.can_write_room`. */
export interface RoomAccess {
  canRead(personId: PersonId, roomId: RoomId): Promise<boolean>;
  canWrite(personId: PersonId, roomId: RoomId): Promise<boolean>;
}

export interface EventAppendInput {
  roomId: RoomId;
  eventType: string;
  payload: Record<string, unknown>;
  actorPersonId?: PersonId;
  agentClient?: AgentClient;
  sessionRef?: string;
}

/** The one method of `EventPort` this package uses. `app.event` is append-only. */
export interface EventAppender {
  append(input: EventAppendInput): Promise<unknown>;
}

/** The one method of `JobPort` this package uses. Postgres is the queue. */
export interface JobQueue {
  enqueue(input: {
    kind: string;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    runAfter?: Date;
  }): Promise<void>;
}

/** `ProjectionPort.invalidate`: a new document makes the room brief stale. */
export interface ProjectionInvalidator {
  invalidate(input: { personId?: PersonId; roomId?: RoomId }): Promise<void>;
}

/** The slice of `LlmPort` documents needs. A full `LlmPort` satisfies it. */
export interface DocumentLlm {
  embed(texts: string[]): Promise<number[][]>;
  summarise(input: { texts: string[]; budgetTokens: number }): Promise<string>;
}

// ---------------------------------------------------------------------------

export interface DocumentDeps {
  blobs: import('./blob-store.js').BlobStore;
  documents: DocumentStore;
  chunks: ChunkStore;
  rooms: RoomAccess;
  events: EventAppender;
  jobs: JobQueue;
  projection: ProjectionInvalidator;
  llm: DocumentLlm;
  /** Injectable so tests get stable timestamps. */
  now?: () => Date;
}
