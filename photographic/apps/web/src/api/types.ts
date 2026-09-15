/** Wire shapes from `apps/rest` serialisers — only the fields the room UI needs. */

export interface RoomSummaryDto {
  roomId: string;
  slug: string;
  title: string;
  kind: 'personal' | 'shared';
  role: string;
  oneLine: string;
  memberCount: number;
  unseenCount: number;
}

export interface RoomDto {
  id: string;
  kind: 'personal' | 'shared';
  slug: string;
  title: string;
  description: string | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface BriefDto {
  roomId: string;
  rendered: string;
  tokenCount: number;
  stale: boolean;
  builtAt: string;
}

export interface RoomMemberDto {
  personId: string;
  displayName: string | null;
  role: string;
}

/** GET /v1/rooms/:id/items — active memories for the shared-room screen. */
export interface RoomItemDto {
  shortId: string;
  kind: string;
  body: string;
}

/** GET /v1/rooms/:id/documents — Dokument shelf rows. */
export interface RoomDocumentDto {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  byteSizeLabel: string;
  createdAt: string;
  /** Mirrors `app.extraction_status`. `extracted` is the only searchable one. */
  extraction: 'pending' | 'extracted' | 'unsupported' | 'empty' | 'failed';
  /** Swedish, and shown: why there is no text. Null when extraction worked. */
  extractionError: string | null;
  warnings: string[];
  pageCount: number | null;
  chunkCount: number;
  searchable: boolean;
  summary: string | null;
}

/** `GET /v1/storage` — the 10 GB product limit and how much of it is used. */
export interface StorageDto {
  bytesUsed: number;
  limitBytes: number;
  objectCount: number;
  usedLabel: string;
  limitLabel: string;
  remainingLabel: string;
  /** 0–1, already clamped by the API. */
  fraction: number;
}

export interface RenderedItemDto {
  shortId: string;
  body: string;
}

export interface ProfileSectionsDto {
  identity: RenderedItemDto[];
  hardFacts: RenderedItemDto[];
  preferences: RenderedItemDto[];
  instructions: RenderedItemDto[];
  never: RenderedItemDto[];
  currentFocus: RenderedItemDto[];
}

/** One of the six fixed Personal Compass principles, personal wording or the default. */
export interface CompassEntryDto {
  key: string;
  text: string;
  source: 'default' | 'personal';
  shortId: string | null;
}

export interface ProfileDto {
  rendered: string;
  sections: ProfileSectionsDto;
  compass: CompassEntryDto[];
  tokenCount: number;
  itemCount: number;
  version: number;
  builtAt: string;
}

export interface ItemDto {
  shortId: string;
  roomId: string;
  kind: string;
  body: string;
  status: string;
}

export interface ForgetResponse {
  item: ItemDto;
  undoToken: string;
  daysRecoverable: number;
}

/** Public GET /v1/invites/:token — no auth, harder rate limit. */
export interface InvitePreviewDto {
  room: { title: string; description: string | null };
  invitedByName: string | null;
  /** Newline-separated memory bodies, capped server-side. */
  preview: string | null;
  role: string;
  expiresAt: string;
}

/** GET /v1/clients — per-AI delivery lights. */
export interface ClientHealthDto {
  agentClient: string;
  displayName: string;
  lastSeenAt: string;
  profileDelivered: boolean;
  deliveryMethod: string | null;
  degraded: boolean;
  /**
   * The person disconnected this client. The server has sent it all along; this type
   * did not declare it, so it was dropped at the boundary and the screen rendered a
   * revoked client exactly like a live one.
   */
  revoked: boolean;
}

/**
 * What accepting a proposal will actually do.
 *
 * Kept on the card rather than collapsed into "spara", because a request to share
 * something with four people and a request to write one line into your own private
 * memory are not the same decision and must not read the same.
 */
export type ProposalIntentDto = 'remember' | 'share' | 'update';

/** GET /v1/memory/proposals — pending approval cards. */
export interface ProposalDto {
  id: string;
  roomId: string;
  intent: ProposalIntentDto;
  kind: string;
  body: string;
  reason: string;
  proposedByClient: string | null;
  createdAt: string;
}

/**
 * Which model has seen this memory's own words.
 *
 * `external` is the one a person cares about: true means the text was sent to a third
 * party to make it searchable by meaning. Null on the response means no vector was ever
 * computed, and absent means this server predates the field — two different things, and
 * neither of them is "no".
 */
export interface EmbeddingProvenanceDto {
  provider: string;
  model: string;
  external: boolean;
  at: string;
}

/**
 * GET /v1/memory/:shortId/provenance — the answer to "hur vet du det om mig?" for one
 * memory, rather than for one day in the calendar.
 */
export interface ProvenanceDto {
  shortId: string;
  body: string | null;
  roomTitle: string;
  savedAt: string;
  savedByClient: string | null;
  approvedByName: string | null;
  /** Why it was stored where it was stored, in one sentence the router wrote. */
  motivation: string | null;
  /** Where the information came from before it was a memory. */
  source: MemorySourceDto | null;
  /** True once it has been corrected at least once. */
  changed: boolean;
  /** Optional: served once `0016_embedding_provenance` is deployed, null before a vector. */
  embedding?: EmbeddingProvenanceDto | null;
  /** Everything that has happened to this one memory, oldest first. */
  timeline: HistoryEntryDto[];
}

/** GET /v1/trash — soft-deleted memories still recoverable. */
export interface TrashEntryDto {
  shortId: string;
  roomId: string;
  roomTitle: string;
  kind: string;
  body: string;
  deletedAt: string;
  deletedByClient: string | null;
  deleteReason: string | null;
  purgeAfter: string;
  daysRemaining: number;
}

/** The eight things that can happen to a memory, as the calendar names them. */
export type MemoryEventKindDto =
  | 'saved_private'
  | 'saved_to_room'
  | 'shared'
  | 'updated'
  | 'moved'
  | 'deleted'
  | 'restored'
  | 'disputed';

export interface MemorySourceDto {
  kind: 'conversation' | 'document' | 'import' | 'manual' | 'unknown';
  label: string;
  ref: string | null;
  uri: string | null;
}

/** The six questions section 4 of the scope says every memory must answer. */
export interface EventProvenanceDto {
  learnedAt: string;
  agentClient: string | null;
  actorName: string | null;
  source: MemorySourceDto | null;
  roomId: string;
  roomTitle: string;
  roomKind: 'personal' | 'shared';
  motivation: string | null;
  explicit: boolean;
  wasApproved: boolean;
  changed: boolean;
}

export interface CalendarEntryDto {
  seq: number;
  kind: MemoryEventKindDto;
  occurredAt: string;
  body: string | null;
  /** What it said before. Set on an edit, and the reason the log exists. */
  previousBody: string | null;
  shortId: string | null;
  itemKind: string | null;
  fromRoomTitle: string | null;
  toRoomTitle: string | null;
  sharedWith: Array<{ name: string | null; role: string }> | null;
  disputes: Array<{ shortId: string | null; body: string | null; authorName: string | null }> | null;
  /** Somebody else did this, in a room shared with them. */
  byOtherMember: boolean;
  redacted: boolean;
  provenance: EventProvenanceDto;
}

/** GET /v1/calendar/day — every memory event for one local day, oldest first. */
export interface CalendarDayDto {
  date: string;
  timeZone: string;
  roomId: string | null;
  roomTitle: string | null;
  entries: CalendarEntryDto[];
  counts: Record<MemoryEventKindDto, number>;
  byOthersCount: number;
  previousDate: string | null;
  nextDate: string | null;
}

/** GET /v1/calendar/events/:seq — the zoom from a day down to the original source. */
export interface MemoryEventDetailDto {
  entry: CalendarEntryDto;
  timeline: CalendarEntryDto[];
  revisions: Array<{
    seq: number;
    at: string;
    body: string | null;
    previousBody: string | null;
    agentClient: string | null;
    motivation: string | null;
  }>;
  source:
    | (MemorySourceDto & {
        at: string | null;
        agentClient: string | null;
        transport: string | null;
        alsoFromHere: Array<{ seq: number; shortId: string | null; body: string | null }>;
      })
    | null;
  currentBody: string | null;
  trash: { purgeAfter: string; daysRemaining: number } | null;
}

/**
 * GET /v1/search — "Fråga mitt minne". One shape for a memory, a document chunk or a
 * calendar entry; `occurredAt`/`shortId`/`documentId`/`seq`/`action` are only set for
 * the kind they belong to.
 */
export interface AskHitDto {
  kind: 'memory' | 'document' | 'event';
  roomId: string;
  roomTitle: string;
  text: string;
  score: number;
  occurredAt: string | null;
  shortId: string | null;
  documentId: string | null;
  seq: number | null;
  action: string | null;
}

/** GET /v1/history — sparse change log, not an audit dump. */
export interface HistoryEntryDto {
  seq: number;
  action: string;
  occurredAt: string;
  roomId: string;
  roomTitle: string;
  shortId: string | null;
  body: string | null;
  agentClient: string | null;
  actorName: string | null;
  wasApproved: boolean;
  redacted: boolean;
}
