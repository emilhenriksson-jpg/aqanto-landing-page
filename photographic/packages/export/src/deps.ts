/**
 * What building an archive needs from the outside world.
 *
 * Narrow and paged. Every read that can grow without a ceiling — events, items,
 * documents — is a page function rather than a list, because the whole point of the
 * NDJSON format is that nothing is ever fully resident, and a dependency that returns
 * an array would quietly undo that at the seam.
 *
 * Declared here rather than imported from `@photographic/core` so this package can be
 * tested without a database and without `Services`. `@photographic/db` satisfies it
 * structurally.
 */

import type { BlobStore } from '@photographic/documents';

export type { BlobStore };

export interface ExportEvent {
  seq: number;
  id: string;
  roomId: string;
  eventType: string;
  payload: Record<string, unknown>;
  actorPersonId: string | null;
  agentClient: string | null;
  sessionRef: string | null;
  approvedBy: string | null;
  occurredAt: Date;
}

export interface ExportItem {
  id: string;
  shortId: string;
  roomId: string;
  kind: string;
  body: string;
  status: string;
  sensitivity: string;
  validFrom: Date;
  validTo: Date | null;
  supersededBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportDocument {
  id: string;
  roomId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  checksum: string;
  storageKey: string;
  uploadedBy: string;
  createdAt: Date;
  extraction: string;
  /** Our extraction, not the AI summary. Written beside the original, never instead. */
  text: string | null;
  summary: string | null;
}

export interface ExportRoom {
  id: string;
  slug: string;
  kind: 'personal' | 'shared';
  title: string;
  description: string | null;
  createdAt: Date;
  role: string;
  members: Array<{ personId: string; displayName: string | null; role: string }>;
}

export interface ExportPerson {
  id: string;
  handle: string | null;
  displayName: string | null;
  email: string | null;
}

/** A page of rows plus the cursor to continue from. */
export interface Page<T> {
  rows: T[];
  /** Null when this was the last page. */
  cursor: number | null;
}

export interface ExportSource {
  person(personId: string): Promise<ExportPerson>;

  /**
   * Rooms the person could reach *at the moment the job runs*, not when it was
   * requested. A room they left in between must not appear in the archive, and the
   * request is minutes to hours old by the time this is called.
   */
  rooms(personId: string): Promise<ExportRoom[]>;

  /** The highest `seq` in the log, so the archive can say which snapshot it is. */
  latestSeq(): Promise<number>;

  /**
   * Events, ordered by seq, paged.
   *
   * `roomIds` is the set of rooms to read at all. `actorOnly` narrows to events this
   * person is the actor of, which is how a shared room contributes only the person's own
   * history when the scope is `own`.
   */
  events(input: {
    roomIds: string[];
    actorPersonId: string;
    actorOnlyRoomIds: string[];
    throughSeq: number;
    afterSeq: number;
    limit: number;
  }): Promise<Page<ExportEvent>>;

  items(input: {
    roomIds: string[];
    /** Items in these rooms are included only if `itemIds` contains them. */
    actorOnlyRoomIds: string[];
    itemIds: string[];
    afterRowId: number;
    limit: number;
  }): Promise<Page<ExportItem>>;

  documents(input: {
    roomIds: string[];
    actorOnlyRoomIds: string[];
    uploadedBy: string;
    afterRowId: number;
    limit: number;
  }): Promise<Page<ExportDocument>>;

  /** Display names for everyone appearing as an actor, so the log reads as prose. */
  people(personIds: string[]): Promise<ExportPerson[]>;
}

export interface ExportDeps {
  source: ExportSource;
  /** Reads document originals, and writes the finished archive. */
  blobs: BlobStore;
  now?: () => Date;
  /** Rows per page. Small in tests so paging is actually exercised. */
  pageSize?: number;
}
