/**
 * Domain types for Photographic.
 *
 * These mirror `packages/db/migrations/0001_init.sql` exactly. The schema is frozen:
 * if you need a shape that is not here, add a migration and update this file in the
 * same change, never one without the other.
 */

export type PersonId = string & { readonly __brand: 'PersonId' };
export type RoomId = string & { readonly __brand: 'RoomId' };
export type ItemId = string & { readonly __brand: 'ItemId' };
export type DocumentId = string & { readonly __brand: 'DocumentId' };
export type ChunkId = string & { readonly __brand: 'ChunkId' };
export type InviteId = string & { readonly __brand: 'InviteId' };
export type ProposalId = string & { readonly __brand: 'ProposalId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type EventSeq = number & { readonly __brand: 'EventSeq' };

/** Short, speakable handle (`p-7k2m`) a model uses to address one item. */
export type ShortId = string & { readonly __brand: 'ShortId' };

export type RoomKind = 'personal' | 'shared';
export type MemberRole = 'owner' | 'editor' | 'viewer';
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
export type ItemStatus = 'active' | 'superseded' | 'archived' | 'deleted';
export type Sensitivity = 'normal' | 'sensitive' | 'local_only';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

/**
 * `instruction` is deliberately distinct from `fact`. Instructions change how every
 * connected model behaves at once, so they render into system-prompt position and
 * always require explicit approval. A wrong fact is annoying; a wrong instruction
 * degrades every chat the person has.
 */
export type ItemKind =
  | 'identity'
  | 'fact'
  | 'preference'
  | 'instruction'
  | 'decision'
  | 'note'
  | 'never';

/** Which surface produced a read or write. Used for provenance and health reporting. */
export type AgentClient =
  | 'claude-desktop'
  | 'claude-mobile'
  | 'claude-code'
  | 'chatgpt-web'
  | 'codex'
  | 'cursor'
  | 'voice'
  | 'web'
  | 'api'
  | 'unknown';

export type Transport = 'mcp' | 'rest' | 'realtime' | 'hook' | 'web';

/** How the personal profile reached the model, ranked by how deterministic it is. */
export type DeliveryMethod =
  | 'system_prompt'      // our own client; guaranteed
  | 'hook'               // SessionStart hook; deterministic where supported
  | 'mcp_instructions'   // InitializeResult.instructions; dropped by some clients today
  | 'tool_call';         // the model chose to call get_context; best effort

export interface Person {
  id: PersonId;
  handle: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  locale: string;
  createdAt: Date;
}

export interface Room {
  id: RoomId;
  kind: RoomKind;
  slug: string;
  title: string;
  description: string | null;
  sensitivity: Sensitivity;
  createdBy: PersonId;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface Membership {
  personId: PersonId;
  roomId: RoomId;
  role: MemberRole;
  invitedBy: PersonId | null;
  joinedAt: Date;
  leftAt: Date | null;
}

export interface Invite {
  id: InviteId;
  roomId: RoomId;
  invitedBy: PersonId;
  channel: 'email' | 'sms';
  destination: string;
  role: MemberRole;
  status: InviteStatus;
  previewAllowed: boolean;
  expiresAt: Date;
  acceptedBy: PersonId | null;
}

export interface Item {
  id: ItemId;
  shortId: ShortId;
  roomId: RoomId;
  kind: ItemKind;
  body: string;
  structured: Record<string, unknown>;
  sensitivity: Sensitivity;
  status: ItemStatus;
  validFrom: Date;
  validTo: Date | null;
  supersededBy: ItemId | null;
  salience: number;
  tokenEstimate: number;
  lastUsedAt: Date | null;
  useCount: number;
  createdAt: Date;

  /** Set only while the item is in the trash. See `TRASH_RETENTION_DAYS`. */
  deletedAt: Date | null;
  deletedBy: PersonId | null;
  deletedByClient: AgentClient | null;
  purgeAfter: Date | null;
  deleteReason: string | null;
}

/**
 * One item in the trash. Carries `daysRemaining` pre-computed because every surface
 * that shows the trash needs it, and a model asked "is it really gone" should not have
 * to do date arithmetic to answer.
 */
export interface TrashEntry {
  shortId: ShortId;
  roomId: RoomId;
  roomTitle: string;
  kind: ItemKind;
  body: string;
  deletedAt: Date;
  deletedBy: PersonId | null;
  deletedByClient: AgentClient | null;
  deleteReason: string | null;
  purgeAfter: Date;
  daysRemaining: number;
}

export type HistoryAction =
  | 'saved'
  | 'updated'
  | 'superseded'
  | 'deleted'
  | 'restored'
  | 'purged'
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'document_added'
  | 'room_created'
  | 'member_joined'
  | 'member_left';

/**
 * One line of user-facing history.
 *
 * `body` is null once the memory has been purged: the entry survives so the feed can
 * still show that something was removed, but the text is gone from the log as well as
 * from the item. A trash that promises deletion has to mean it.
 */
export interface HistoryEntry {
  seq: EventSeq;
  action: HistoryAction;
  occurredAt: Date;
  roomId: RoomId;
  roomTitle: string;
  shortId: ShortId | null;
  body: string | null;
  /** Which AI did it, or `web`/`voice` when the person did it themselves. */
  agentClient: AgentClient | null;
  actorName: string | null;
  /** True when this passed through an explicit approval rather than landing silently. */
  wasApproved: boolean;
  redacted: boolean;
}

/** The answer to "how do you know that about me?". */
export interface Provenance {
  shortId: ShortId;
  body: string | null;
  roomTitle: string;
  savedAt: Date;
  savedByClient: AgentClient | null;
  approvedByName: string | null;
  /** Everything that has happened to this one memory, oldest first. */
  timeline: HistoryEntry[];
}

export interface MemoryEvent {
  seq: EventSeq;
  id: string;
  roomId: RoomId;
  eventType: string;
  payload: Record<string, unknown>;
  actorPersonId: PersonId | null;
  agentClient: AgentClient | null;
  sessionRef: string | null;
  approvedBy: PersonId | null;
  occurredAt: Date;
}

export interface Proposal {
  id: ProposalId;
  roomId: RoomId;
  personId: PersonId;
  kind: ItemKind;
  body: string;
  /** Human-readable explanation of why this could not be written automatically. */
  reason: string;
  conflictsWith: ItemId | null;
  proposedByClient: AgentClient | null;
  status: ProposalStatus;
  createdAt: Date;
}

/**
 * The personal profile. Never retrieved by search: it is injected whole, every time.
 * That is why it carries a hard token ceiling rather than a relevance score.
 */
export interface Profile {
  personId: PersonId;
  rendered: string;
  sections: ProfileSections;
  tokenCount: number;
  itemCount: number;
  builtFromSeq: EventSeq;
  version: number;
  builtAt: Date;
}

/**
 * Structured rather than a flat fact list, because injection quality depends on it.
 * Facts and instructions stay separate: instructions belong in system-prompt position.
 */
export interface ProfileSections {
  identity: RenderedItem[];
  hardFacts: RenderedItem[];
  preferences: RenderedItem[];
  instructions: RenderedItem[];
  never: RenderedItem[];
  currentFocus: RenderedItem[];
}

export interface RenderedItem {
  shortId: ShortId;
  body: string;
}

export interface Brief {
  roomId: RoomId;
  rendered: string;
  tokenCount: number;
  builtFromSeq: EventSeq;
  stale: boolean;
  builtAt: Date;
}

/**
 * What a model receives at session start. Assembled, budgeted and cached; never
 * built synchronously from raw items, because voice latency makes that impossible.
 */
export interface ContextBundle {
  personId: PersonId;
  profile: Profile;
  rooms: RoomSummary[];
  activeRoom: ActiveRoomContext | null;
  tokenCount: number;
  bundleVersion: string;
  builtAt: Date;
}

export interface RoomSummary {
  roomId: RoomId;
  slug: string;
  title: string;
  role: MemberRole;
  oneLine: string;
  unseenCount: number;
}

export interface ActiveRoomContext {
  roomId: RoomId;
  title: string;
  brief: string;
  /** Events the person has not seen since `room_read_state.last_seen_seq`. */
  sinceLastSeen: string[];
}

export interface ClientSession {
  id: SessionId;
  personId: PersonId;
  agentClient: AgentClient;
  transport: Transport;
  startedAt: Date;
  profileDelivered: boolean;
  profileVersion: number | null;
  deliveryMethod: DeliveryMethod | null;
}

export interface SearchHit {
  kind: 'item' | 'chunk';
  id: string;
  roomId: RoomId;
  shortId: ShortId | null;
  text: string;
  score: number;
  documentId: DocumentId | null;
}
