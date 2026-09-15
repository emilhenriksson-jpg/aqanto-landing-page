/**
 * Domain types for Photographic.
 *
 * These mirror `packages/db/migrations/0001_init.sql` exactly. The schema is frozen:
 * if you need a shape that is not here, add a migration and update this file in the
 * same change, never one without the other.
 */

import type { CompassEntry } from './compass.js';

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
 *
 * `compass` is a further distinction from `instruction`, not a synonym for it: it is
 * one of exactly six fixed principles (`packages/core/src/compass.ts`), never a
 * free-form seventh, rendered in its own budgeted block rather than folded into the
 * standing-instructions section. Same approval gate, same provenance, same trash — the
 * difference is entirely about which slot it fills and how it renders, not about how it
 * is stored.
 *
 * `name` is the person's own first name, mirroring `compass` in one way and departing
 * from it in another. Mirrors it: a dedicated kind rather than a settings column, so it
 * carries the same provenance, history and 30-day trash treatment as anything else a
 * person owns, with at most one active at a time (see `IngestPort.setFirstName`).
 * Departs from it: a name has no MCP tool and no propose path at all — it is set once,
 * directly, from the person's own browser session (first sign-in or the account
 * screen), so unlike a Compass principle it is never something a model can suggest.
 * `remember` and `propose` both refuse this kind outright, the same defence-in-depth
 * `compass` already has for its own, different reason.
 */
export type ItemKind =
  | 'identity'
  | 'fact'
  | 'preference'
  | 'instruction'
  | 'decision'
  | 'note'
  | 'never'
  | 'compass'
  | 'name';

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

  /**
   * Who wrote it.
   *
   * A projection of the `item.created` event, like every other column here, but the one
   * that several rules turn on: in a shared room the author owns their own contribution,
   * which is what makes "editors may delete their own lines and owners may tidy up"
   * expressible, and what lets a contradiction across two people be recognised as a
   * disagreement rather than a correction. Deriving it from a jsonb payload on every
   * permission check is a join in a hot path, so it is written down.
   */
  authorPersonId: PersonId;
  /** Which registered client wrote it, when one is known. See `Actor.clientId`. */
  authorClientId: string | null;

  /**
   * Other memories in the same room that contradict this one and are still unresolved.
   *
   * Symmetric: both sides carry each other. A projection of `item.disputed` and
   * `item.dispute_resolved`, so the log stays the truth and this stays convenient.
   */
  disputedBy: ItemId[];

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
  | 'shared'
  | 'moved'
  | 'deleted'
  | 'restored'
  | 'purged'
  | 'disputed'
  | 'dispute_resolved'
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
  /** Why it was stored where it was stored, in one human sentence. */
  motivation: string | null;
  /** Where the information itself came from, before Photographic saw it. */
  source: MemorySource | null;
  /** True once the memory has been corrected at least once. */
  changed: boolean;
  /** Everything that has happened to this one memory, oldest first. */
  timeline: HistoryEntry[];
}

/**
 * Where a piece of information came from, before it was a memory.
 *
 * Not the same thing as which client wrote it. Claude writing a fact during a
 * conversation and Claude extracting the same fact out of a PDF are the same client and
 * two different origins, and "hur vet du det?" is only answered by the second one.
 */
export interface MemorySource {
  kind: 'conversation' | 'document' | 'import' | 'manual' | 'unknown';
  /** Human-readable, Swedish, shown as-is: "Samtal med Claude", "avtal.pdf". */
  label: string;
  /** Opaque pointer to the origin: a session ref, a document id, an import name. */
  ref: string | null;
  /** A link back to the original, when one exists. */
  uri: string | null;
}

/**
 * One row of the append-only log.
 *
 * The provenance fields are the answer to the six questions every memory has to be able
 * to answer — what, when we learned it, where from, which client wrote it, where it was
 * stored and why there. They live on the event rather than on the item because the item
 * is the current value and the event is what happened: an item that has been corrected
 * twice has one body and three separate stories about how it got there.
 */
export interface MemoryEvent {
  seq: EventSeq;
  id: string;
  roomId: RoomId;
  eventType: string;
  payload: Record<string, unknown>;
  actorPersonId: PersonId | null;
  agentClient: AgentClient | null;
  /** The registered client, when one is known. An identity, unlike `agentClient`. */
  clientId: string | null;
  /** The client session this write belongs to — the thread back to the conversation. */
  sessionRef: string | null;
  approvedBy: PersonId | null;
  occurredAt: Date;

  /** Short, human-readable reason this happened, and happened *there*. */
  motivation: string | null;
  /** True when a person asked for this in so many words, rather than automation. */
  explicit: boolean;
  /** Where the information came from. Derived from the session when nothing was given. */
  source: MemorySource | null;
  /** Set on `item.moved` and `item.shared`: which room it left and which it reached. */
  fromRoomId: RoomId | null;
  toRoomId: RoomId | null;
}

/**
 * The seven things that can happen to a memory, as the calendar names them.
 *
 * Deliberately not the log's own event types. The log records mechanism (`item.created`
 * happens whether a fact lands in your private memory or in a room five people read);
 * this records what it meant, which is what a day in the calendar is a list of. The
 * mapping between them is in `memoryEventKindOf`, in one place, so the two never drift.
 */
export type MemoryEventKind =
  | 'saved_private'
  | 'saved_to_room'
  | 'shared'
  | 'updated'
  | 'moved'
  | 'deleted'
  | 'restored'
  /**
   * Two people in a room saying incompatible things.
   *
   * The eighth. The scope listed seven and this is a genuine addition rather than a
   * subdivision: it is the only one where nothing changed, which is exactly why it cannot
   * hide under `updated`, and two people disagreeing is not something a person should
   * have to go looking for.
   */
  | 'disputed';

/** Who could read a memory at the moment it was shared. Recorded, never recomputed. */
export interface SharedWith {
  personId: PersonId | null;
  name: string | null;
  role: MemberRole;
}

/**
 * Everything the product promises a memory can answer, on one event.
 *
 * Section 4 of the scope is a list of six questions. This is that list as a type, which
 * is the only way to be sure every surface can answer all six rather than the four that
 * happened to be easy.
 */
export interface EventProvenance {
  /** When we learned it. Not when it happened in the world. */
  learnedAt: Date;
  /** Which AI wrote it, or `web` when the person did it themselves. */
  agentClient: AgentClient | null;
  actorName: string | null;
  /** Where the information came from. */
  source: MemorySource | null;
  /** Where it was stored. */
  roomId: RoomId;
  roomTitle: string;
  roomKind: RoomKind;
  /** Why there. */
  motivation: string | null;
  /** Whether a human asked for it explicitly. */
  explicit: boolean;
  /** Whether it went through the approval queue. */
  wasApproved: boolean;
  /** Whether the memory has been corrected since. */
  changed: boolean;
}

/** One memory event, as a day in the calendar shows it. */
export interface CalendarEntry {
  seq: EventSeq;
  kind: MemoryEventKind;
  occurredAt: Date;
  /** What. Null once the text has been purged. */
  body: string | null;
  /**
   * What it said before this event, for `updated` and nothing else.
   *
   * Carried rather than looked up because the whole point of the log is that the
   * correction does not erase the original: 15 oktober is still in the day it was
   * written even after it became 1 november.
   */
  previousBody: string | null;
  shortId: ShortId | null;
  itemKind: ItemKind | null;
  /** Set on `moved` and `shared`. */
  fromRoomTitle: string | null;
  toRoomTitle: string | null;
  /** Set on `shared`: who could read it as of that moment. */
  sharedWith: SharedWith[] | null;
  /** Set on `disputed`: the two statements that cannot both be true. */
  disputes: Array<{ shortId: ShortId | null; body: string | null; authorName: string | null }> | null;
  provenance: EventProvenance;
  /**
   * Somebody else did this, in a room you share with them.
   *
   * There is no owner moderation of incoming material — nothing waits in a queue for the
   * room's owner to let it in — so noticing is the whole defence. A room's day has to make
   * other people's contributions the thing you see first, not a line that reads the same
   * as your own forty.
   */
  byOtherMember: boolean;
  redacted: boolean;
}

/**
 * One day of the memory's timeline.
 *
 * Days only. Week, month and year summaries are derivable from the same log whenever
 * they are wanted, and building them first would have meant shipping a summary of
 * something that did not exist yet.
 */
export interface CalendarDay {
  /** `YYYY-MM-DD`, in `timeZone`. */
  date: string;
  timeZone: string;
  /** Set when the day was asked for about one room rather than everything. */
  roomId: RoomId | null;
  roomTitle: string | null;
  /** Ascending: a day is read forwards, unlike the history feed. */
  entries: CalendarEntry[];
  counts: Record<MemoryEventKind, number>;
  /**
   * How many of the day's events somebody else made.
   *
   * Carried separately because it is the number that changes what the day is *for*. A
   * day where you saved six things is a log; a day where two of them came from Anna is
   * something to read.
   */
  byOthersCount: number;
  /** Nearest earlier and later day that has anything in it, so stepping never dead-ends. */
  previousDate: string | null;
  nextDate: string | null;
}

/** One value a memory has held, with the value it replaced. */
export interface MemoryRevision {
  seq: EventSeq;
  at: Date;
  /** What it said after this change. Null once purged. */
  body: string | null;
  /** What it said before. Null for the original. */
  previousBody: string | null;
  agentClient: AgentClient | null;
  motivation: string | null;
}

/**
 * The source, opened.
 *
 * The last step of the zoom: day -> memory event -> source. `alsoFromHere` is what makes
 * it a place rather than a label — one Claude session that wrote four things reads as one
 * conversation, which is how the person remembers it.
 */
export interface MemorySourceDetail extends MemorySource {
  /** When the source itself began: the session start, the upload, the import. */
  at: Date | null;
  agentClient: AgentClient | null;
  transport: Transport | null;
  alsoFromHere: Array<{ seq: EventSeq; shortId: ShortId | null; body: string | null }>;
}

/** One memory event, zoomed in: how it got here, everything it has said, where it came from. */
export interface MemoryEventDetail {
  entry: CalendarEntry;
  /** Every event about the same memory, oldest first. */
  timeline: CalendarEntry[];
  /** Every value it has held, oldest first: the original and each correction. */
  revisions: MemoryRevision[];
  source: MemorySourceDetail | null;
  /** What the memory says now, or null when it is gone. */
  currentBody: string | null;
  /** Set only while the memory is in the trash. */
  trash: { purgeAfter: Date; daysRemaining: number } | null;
}

/**
 * What accepting a proposal does.
 *
 * `remember` writes the body as a new memory. `update` replaces the text of the memory
 * in `sourceItemId`, keeping its short id. `share` places a memory that already exists
 * into `roomId`.
 *
 * All three exist because a model may ask for things it may not do. A shared room is the
 * clearest case: nothing automatic lands there, so every route into one produces a
 * question rather than a write, and the question is the same queue the person already
 * clears for proposals.
 */
/**
 * `move` is distinct from `share` because approving one must not do the other.
 *
 * A share leaves the original where it was and puts a copy in the target room; a move
 * relocates the row and keeps its short id. While a move into a shared room was queued as
 * `share`, approving it produced a copy — so the memory the person asked to move was
 * still sitting in its old room afterwards, and "flytta p-7k2m" had quietly become
 * "kopiera p-7k2m".
 */
export type ProposalIntent = 'remember' | 'share' | 'update' | 'move';

export interface Proposal {
  id: ProposalId;
  /** The room the memory would end up in. */
  roomId: RoomId;
  personId: PersonId;
  intent: ProposalIntent;
  kind: ItemKind;
  body: string;
  /** Human-readable explanation of why this could not be written automatically. */
  reason: string;
  /**
   * Why it belongs where it is going, decided when the proposal was raised.
   *
   * Not the same sentence as `reason`: that one explains the asking, this one explains the
   * placement, and it is the one that follows the memory onto its event if the person says
   * yes. Null when nothing chose a destination — a hand-named room needs no explanation.
   */
  motivation: string | null;
  conflictsWith: ItemId | null;
  /** Set when `intent` is `share`: the memory being shared. */
  sourceItemId: ItemId | null;
  proposedByClient: AgentClient | null;
  status: ProposalStatus;
  createdAt: Date;
  /**
   * Carried through to the item `write` performs on acceptance. Empty for every
   * proposal except a Compass change, where it names which of the six principles the
   * body fills — see `COMPASS_KEY_FIELD` in `compass.ts`. Without this, an accepted
   * Compass proposal would land as an ordinary instruction with no slot to attach to.
   */
  structured: Record<string, unknown>;
}

/**
 * The personal profile. Never retrieved by search: it is injected whole, every time.
 * That is why it carries a hard token ceiling rather than a relevance score.
 */
export interface Profile {
  personId: PersonId;
  rendered: string;
  sections: ProfileSections;
  /**
   * The six Personal Compass principles, always exactly six, personal wording or the
   * built-in default per slot. Deliberately not one of `ProfileSections`: those are
   * rendered together under the profile's own token ceiling, while the Compass is
   * rendered as its own block with its own budget and is one of the last things
   * dropped rather than one of the first. See `renderCompass` in `@photographic/agent`.
   */
  compass: CompassEntry[];
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
 * A room in one sentence.
 *
 * The brief is what a room contains; the headline is what a room *is*. They are not the
 * same text and cannot be derived from each other by truncation: the first line of a
 * brief is the most recent thing someone said, which tells a model nothing about why the
 * room exists or whether this is the room to write into.
 *
 * Every room has one, and every headline reaches every session, because that is what
 * lets a model know a room exists without reading it. It is therefore the one piece of
 * shared-room text under a hard ceiling measured in tokens rather than characters —
 * twenty rooms times one long sentence is the whole instructions budget.
 */
export interface RoomHeadline {
  roomId: RoomId;
  rendered: string;
  /**
   * Where the sentence came from, which decides whether it is worth rebuilding.
   *
   * `owner` is what the person wrote themselves and is never regenerated. `derived` was
   * summarised from the room's contents and is rebuilt as the room moves on. `empty` is
   * a room with nothing in it yet, which is a normal state for a room created minutes
   * ago and worth saying plainly rather than papering over.
   */
  source: 'owner' | 'derived' | 'empty';
  builtFromSeq: EventSeq;
  stale: boolean;
  builtAt: Date;
}

/**
 * What a model receives at session start. Assembled, budgeted and cached; never
 * built synchronously from raw items, because voice latency makes that impossible.
 *
 * Four things, matching the scope's "spara allt, skicka lite": `profile` is the
 * personal core context and the core memories in it, `rooms` is the room overview,
 * and `recent` is the extremely short "what just happened" line. Everything else —
 * a room's actual contents, the full history, search — is fetched on demand, which is
 * the whole point: this object is deliberately not everything Photographic knows.
 */
export interface ContextBundle {
  personId: PersonId;
  profile: Profile;
  rooms: RoomSummary[];
  /**
   * A handful of the most recent events across every room the person can reach, newest
   * first. Not a feed and not a substitute for one — `list_history` and `GET
   * /v1/history` are the feed. This is the few lines a model can skim before the person
   * has said anything, bounded by `RECENT_ACTIVITY_LIMIT` and `RECENT_TOKEN_BUDGET` and
   * the first thing dropped when the budget is tight. See `recentActivityFor` for where
   * it comes from today and why that read sits behind a seam.
   */
  recent: HistoryEntry[];
  activeRoom: ActiveRoomContext | null;
  tokenCount: number;
  bundleVersion: string;
  builtAt: Date;
}

/**
 * One room as it appears in the overview every session opens with.
 *
 * Deliberately not a trimmed `Room`. This is the shape that has to answer, in a line a
 * model reads in passing: what is this room, is it mine alone or do other people write
 * here, and has anything happened in it since I last looked.
 */
export interface RoomSummary {
  roomId: RoomId;
  slug: string;
  title: string;
  kind: RoomKind;
  role: MemberRole;
  /** The room in one sentence. See `RoomHeadline`. */
  oneLine: string;
  /**
   * Active members including the person themselves, so `1` means a room nobody else
   * has joined yet.
   *
   * Carried because "shared" is the property that changes how a model should behave —
   * what it writes there, whether it should attribute, how careful it should be with
   * something personal — and room kind does not tell you: a room you created and never
   * invited anyone to is shared in kind and private in fact.
   */
  memberCount: number;
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
  /**
   * True when this hit is one side of an unresolved disagreement.
   *
   * Carried on the hit rather than left for the caller to look up, because the rule it
   * exists for is that a model must never receive one side alone. A model handed one of
   * two contradictory statements answers confidently and wrongly; a model handed both,
   * labelled, says there are two different answers — which is true, and is also what
   * gets a person to settle it.
   */
  disputed: boolean;
  /**
   * When an item was saved. `null` for a chunk: document ingestion does not carry this
   * through search yet — see `askMemory` in `ask.ts`, which is the first consumer that
   * needs it and folds documents in without it rather than waiting on that wiring.
   */
  createdAt: Date | null;
}

/**
 * Two statements in one room that cannot both be true, waiting for a person.
 *
 * Deliberately not a table and deliberately not resolved by recency. Whoever wrote last
 * is not whoever is right, and letting the newer write win across authors means anyone
 * in a room can quietly overwrite anyone else — with the other person finding out when
 * their own AI answers wrongly.
 */
export interface Dispute {
  roomId: RoomId;
  roomTitle: string;
  /** Both sides, in the order they were written. Neither is the default winner. */
  sides: DisputeSide[];
  raisedAt: Date;
  /** Why the two were judged incompatible, in one sentence. */
  reason: string;
}

export interface DisputeSide {
  shortId: ShortId;
  itemId: ItemId;
  body: string;
  authorPersonId: PersonId;
  authorName: string | null;
  writtenAt: Date;
}

/**
 * One result from "Fråga mitt minne" (scope §7) — a single ranked list spanning private
 * memory, every room the person can reach, and the calendar/history log, each entry
 * carrying what it takes to link back to where it came from.
 *
 * Deliberately not just `SearchHit`. A memory or a document chunk is something
 * currently true; a calendar entry is something that *happened*, on a date, and may
 * have no current counterpart at all — "vad gjorde Photographic med det jag berättade
 * igår" is a question about an event, not about a fact. One hit shape has to carry
 * both without either case leaving fields meaningless for the other, hence the
 * optional provenance fields being null in the cases where they do not apply.
 */
export type AskHitKind = 'memory' | 'document' | 'event';

export interface AskHit {
  kind: AskHitKind;
  roomId: RoomId;
  roomTitle: string;
  text: string;
  /**
   * Comparable only within the same `kind` group before merging — see
   * `mergeRanked` in `ask.ts`. Never meant to be shown to a person.
   */
  score: number;
  occurredAt: Date | null;
  /** Set for `kind: 'memory'` — the id a person or model addresses this by. */
  shortId: ShortId | null;
  /** Set for `kind: 'document'`. No shortId: a chunk is not independently addressable. */
  documentId: DocumentId | null;
  /** Set for `kind: 'event'` — its position in the append-only log. */
  seq: EventSeq | null;
  action: HistoryAction | null;
}
