import type { ContextCandidate, ContributionPreview, ContributionState, ContributionResolution } from './contributions.js';
/**
 * Ports: every interface an implementation package must satisfy.
 *
 * These exist so that consumers (REST, MCP, web, voice) can be built in parallel with
 * the implementations behind them. If you are implementing a port, do not change its
 * shape -- other packages are already compiling against it. Raise it as a blocker in
 * STATUS.md instead.
 *
 * The rule that keeps rooms from leaking: every read takes `actor` as its first
 * argument and resolves permission itself. A room id supplied by a model is a request,
 * never a grant.
 */

import type {
  ActiveRoomContext,
  AgentClient,
  Brief,
  CalendarDay,
  ChunkId,
  ClientSession,
  ContextBundle,
  DeliveryMethod,
  Dispute,
  DocumentId,
  EventSeq,
  Invite,
  InviteId,
  Item,
  ItemId,
  ItemKind,
  MemberRole,
  HistoryEntry,
  MemoryChange,
  MemoryEvent,
  MemoryEventDetail,
  MemorySource,
  Person,
  PersonId,
  Profile,
  Proposal,
  ProposalId,
  Provenance,
  Room,
  RoomHeadline,
  RoomId,
  RoomSummary,
  SearchHit,
  SessionId,
  ShortId,
  Transport,
  TrashEntry,
  TrashHandle,
} from './domain.js';
import type { RoutingDecision } from './routing.js';

/**
 * Who is acting, resolved from an OAuth token before any port is called.
 * Never construct one of these from model-supplied input.
 */
export interface Actor {
  personId: PersonId;
  agentClient: AgentClient;
  sessionId: SessionId | null;
  /** Empty means "all rooms this person belongs to", resolved per request. */
  roomScope: RoomId[];
  /**
   * The registered OAuth client behind this call, when there is one.
   *
   * `agentClient` is a label derived from a name the client chose for itself, so it says
   * what kind of thing is calling and cannot be trusted to say *which*. This is the
   * identity: one registration, one id, one row in Klienter, revocable on its own. It is
   * optional because the client store is still in process memory — Track 3 moves it to
   * Postgres — and provenance that says nothing is better than provenance that guesses.
   */
  clientId?: string | null;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface IdentityPort {
  /** Creates the person and their personal room in one transaction. */
  register(input: {
    email?: string;
    phone?: string;
    displayName?: string;
    locale?: string;
  }): Promise<{ person: Person; personalRoom: Room }>;

  findById(id: PersonId): Promise<Person | null>;
  findByEmail(email: string): Promise<Person | null>;
  findByPhone(phone: string): Promise<Person | null>;
  personalRoomOf(id: PersonId): Promise<Room>;
}

// ---------------------------------------------------------------------------
// Rooms, membership, invites
// ---------------------------------------------------------------------------

export interface RoomPort {
  create(actor: Actor, input: { title: string; description?: string }): Promise<Room>;
  get(actor: Actor, roomId: RoomId): Promise<Room | null>;
  listForPerson(actor: Actor): Promise<RoomSummary[]>;
  archive(actor: Actor, roomId: RoomId): Promise<void>;

  /**
   * Sets the sentence every session reads about this room.
   *
   * A room's description is not documentation nobody opens: it is the headline the
   * overview prefers over anything summarised, so this is how a person decides what
   * every model they use understands a room to be. Which makes it worth being able to
   * change — a room's purpose is clearest a month in, not at the moment it was named,
   * and until this existed the only way to correct it was to create the room again.
   *
   * `null` hands the sentence back to the summariser.
   */
  describe(actor: Actor, roomId: RoomId, description: string | null): Promise<Room>;

  /** Resolves a name a person spoke ("Buyersclub Ledning") to a room they can reach. */
  resolveByName(actor: Actor, name: string): Promise<Room | null>;

  members(actor: Actor, roomId: RoomId): Promise<Array<{ person: Person; role: MemberRole }>>;

  /**
   * Leaves a shared room. The membership ends; the contributions stay.
   *
   * This is the most consequential promise in the permission model, and it runs the
   * uncomfortable way round on purpose. If forty notes vanished the moment their author
   * left, everyone *else's* memory would change behind their backs: decisions that cite
   * her material stop making sense, and their calendars grow holes none of them caused.
   * Nothing disappears unless somebody decided it should — and that cannot apply only to
   * whoever happens to stay.
   *
   * The price is that you do not get back what you wrote into a shared room, which is
   * acceptable only if it is said beforehand. So `removeContributions` exists and is
   * offered before leaving, it goes through the ordinary trash where the other members
   * can see it happen and an owner can undo it for thirty days, and no owner can take
   * the option away.
   *
   * The person keeps her own calendar history of what she did there; she just cannot read
   * the room any more. What I did is mine, what the room contains is the room's.
   */
  leave(
    actor: Actor,
    roomId: RoomId,
    input?: { removeContributions?: boolean },
  ): Promise<void>;

  /** Owner-only. Same mechanics as leaving, decided by someone else. */
  removeMember(actor: Actor, roomId: RoomId, personId: PersonId): Promise<void>;

  markSeen(actor: Actor, roomId: RoomId): Promise<void>;
}

export interface InvitePort {
  create(
    actor: Actor,
    input: {
      roomId: RoomId;
      channel: 'email' | 'sms';
      destination: string;
      role?: MemberRole;
    },
  ): Promise<{ invite: Invite; url: string }>;

  /**
   * Resolves an invite token for a recipient who may not have an account yet.
   * Returns preview content when the invite allows it, because a signup wall as the
   * first step is where the viral loop dies.
   */
  peek(token: string): Promise<{
    invite: Invite;
    room: Pick<Room, 'id' | 'title' | 'description'>;
    invitedByName: string | null;
    preview: string | null;
  } | null>;

  /**
   * Redeems an invite, once.
   *
   * Single-use, and bound to whoever redeems it. An invite link travels through email,
   * SMS, screenshots and forwards, and "it only works once" is the only assumption a
   * person actually makes about one. Anything that is not `pending` is refused with the
   * same not-found an unknown token gets, so a spent link cannot be told from a
   * fictional one.
   */
  accept(token: string, personId: PersonId): Promise<{ room: Room; role: MemberRole }>;
  revoke(actor: Actor, inviteId: InviteId): Promise<void>;

  /**
   * Open invites for a room, so an owner can see who has been asked.
   *
   * Revoking something you cannot see is not a feature. Owner-only, because the list is
   * the room's future audience.
   */
  listForRoom(actor: Actor, roomId: RoomId): Promise<Invite[]>;

  /**
   * Closes invites whose deadline has passed, by the `expire_invites` job.
   *
   * `expired` was in the enum and never written, so expiry was a runtime comparison and
   * `status` did not describe reality. Writing it down is what makes a list of open
   * invites honest.
   */
  expireOverdue(limit?: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Ingest: the write path
// ---------------------------------------------------------------------------

/**
 * Three tiers, because "never let a model write garbage" and "let every model save
 * small facts automatically" cannot share one rule.
 *
 *  - `auto`            small, concrete, non-contradicting fact. Written immediately,
 *                      shown in the feed, undoable.
 *  - `needs_approval`  contradicts existing state, or is an `instruction`. Instructions
 *                      always need approval: they change every model's behaviour at once.
 *  - `duplicate`       already known. Bumps salience instead of adding a row.
 */
export type WriteDecision =
  | { outcome: 'auto'; item: Item; routing?: RoutingDecision }
  | { outcome: 'needs_approval'; proposal: Proposal; routing?: RoutingDecision }
  | { outcome: 'duplicate'; existing: Item };

/**
 * The result of putting an existing memory somewhere else.
 *
 * `needs_approval` is not an error path. It is what a model asking to share gets, every
 * time, because sharing is an act a person performs and automation only ever proposes.
 */
export type PlacementDecision =
  | { outcome: 'placed'; item: Item; event: MemoryEvent }
  | { outcome: 'needs_approval'; proposal: Proposal };

/**
 * The result of editing a memory.
 *
 * An edit used to be the one write that skipped the approval gate entirely, which made
 * it the cheapest way to change what a shared room says: save nothing, rewrite something
 * that is already there. It goes through the same gate as every other write now, so in a
 * shared room it queues.
 */
export type UpdateDecision =
  | { outcome: 'updated'; item: Item }
  | { outcome: 'needs_approval'; proposal: Proposal };

/**
 * What a write says about itself beyond the text.
 *
 * Optional everywhere, because a caller that supplies none of it still produces a
 * complete provenance record — the client, the session and the room are already known,
 * and the motivation is derived. This is how a caller says something better than the
 * default, not a form it has to fill in.
 */
export interface WriteProvenance {
  /** One short human sentence: why this, why here. Derived when absent. */
  motivation?: string;
  /** Where the information came from, if it was not this conversation. */
  source?: MemorySource;
}

export interface IngestPort {
  contributionState(actor: Actor): Promise<ContributionState>;
  pauseContributions(actor: Actor, paused: boolean): Promise<ContributionState>;
  prepareContributions(actor: Actor, input: { candidates: ContextCandidate[]; batchId: string }): Promise<ContributionPreview>;
  resolveContributions(actor: Actor, input: { ids: ProposalId[]; reviewedIds: ProposalId[]; expectedReasons?: Record<string, string>; accept: boolean }): Promise<ContributionResolution[]>;

  /**
   * The write path.
   *
   * `roomId` is optional, and leaving it out is the interesting case: it means nobody
   * named a room, so Photographic decides where the memory belongs and records why. That
   * used to default silently to the personal room, which made "the system decides where
   * it goes" untrue in the only case where it mattered. See `routeMemory`.
   *
   * Routing picks a target; it does not decide whether the write lands. A routed room
   * still meets the same approval gate a hand-named one would.
   */
  remember(
    actor: Actor,
    input: {
      roomId?: RoomId;
      body: string;
      kind?: ItemKind;
      sensitivity?: 'normal' | 'sensitive';
      /** Set by the caller when the human explicitly asked for this write. */
      explicit?: boolean;
    } & WriteProvenance,
  ): Promise<WriteDecision>;

  /**
   * Queues something for approval without attempting to write it.
   *
   * `remember` decides the tier itself, which is right for a model mid-conversation but
   * wrong for a bulk import: memories carried over from ChatGPT arrive with no evidence
   * that the person ever confirmed them, so inheriting them silently means inheriting
   * another system's mistakes. This is the path that always ends in a proposal.
   */
  propose(
    actor: Actor,
    input: {
      roomId: RoomId;
      body: string;
      kind?: ItemKind;
      reason?: string;
      source?: string;
      /** Carried onto the `Proposal` and, on acceptance, onto the resulting `Item`. */
      structured?: Record<string, unknown>;
    },
  ): Promise<Proposal>;

  update(
    actor: Actor,
    shortId: ShortId,
    roomId: RoomId,
    body: string,
    provenance?: WriteProvenance,
  ): Promise<UpdateDecision>;

  /**
   * Places a copy of a memory into another room. Never automatic.
   *
   * Copies rather than relocates, and that is the whole point: a private memory that has
   * been shared exists twice, once in the personal room where it stays private and once
   * in the shared room where other people can read it. Moving it would mean the personal
   * memory is now visible to a room, which section 1 of the scope says can never happen.
   *
   * There is no way to ask for the placement itself. This *always* returns a proposal,
   * and the only thing that turns a proposal into a placement is `resolveProposal`, which
   * `apps/rest` restricts to the person's own browser session.
   *
   * It used to take `confirmed?: boolean`, meaning any caller holding `memory.write` —
   * every connected model, and anyone holding a stolen token — could set one field and
   * copy a private memory into a room other people read, with nobody approving anything.
   * The database trigger did not catch it either: it checks `placement_explicit`, which
   * records that *something* asked for the placement and cannot tell a person from a
   * flag in a request body. A boolean a caller supplies is the caller's claim about a
   * human, which is the same mistake `explicit` made on the write path and is refused
   * here the same way — by there being no field to set.
   */
  share(
    actor: Actor,
    input: {
      shortId: ShortId;
      /** Which room the memory is in now. Defaults to searching the actor's rooms. */
      fromRoomId?: RoomId;
      toRoomId: RoomId;
    } & WriteProvenance,
  ): Promise<PlacementDecision>;

  /**
   * Relocates a memory: private -> room, or room -> room.
   *
   * The short id survives, because "flytta p-7k2m till Buyersclub Ledning" has to still
   * refer to p-7k2m afterwards.
   *
   * A move into a shared room widens the audience exactly as a share does, so it takes
   * the same route: a proposal, approved first-party, with no field a client can set to
   * skip it. A move that only ever narrows the audience — into the person's own personal
   * room — happens directly, because nobody new can read it afterwards.
   */
  move(
    actor: Actor,
    input: {
      shortId: ShortId;
      fromRoomId?: RoomId;
      toRoomId: RoomId;
    } & WriteProvenance,
  ): Promise<PlacementDecision>;

  /**
   * Soft delete, always reversible. A model deleting the wrong memory loses the user.
   *
   * `reason` is the person's own phrasing, shown in the trash. It is what makes the
   * trash readable a week later: "borttaget" against forty entries is a list to
   * re-derive, while "flyttade från Stockholm" is an answer.
   */
  forget(
    actor: Actor,
    shortId: ShortId,
    roomId: RoomId,
    reason?: string,
  ): Promise<{ item: Item; undoToken: string }>;
  undo(actor: Actor, undoToken: string): Promise<Item>;

  listProposals(actor: Actor): Promise<Proposal[]>;
  resolveProposal(actor: Actor, id: ProposalId, accept: boolean): Promise<Item | null>;

  /**
   * Sets the person's own first name.
   *
   * Stored as an ordinary item in the personal room under the `name` kind, not a
   * settings field — so it gets exactly the same provenance, history and 30-day trash
   * treatment as anything else a person owns, the same way `0015_personal_compass.sql`
   * stored the Compass as memory rather than as a second source of truth beside it. At
   * most one is ever active: setting it again supersedes the old one through the same
   * path a correction takes, rather than leaving two statements about the same name.
   *
   * Always writes directly and never queues for approval. A Compass principle changes
   * how every connected model behaves and can be proposed mid-conversation, which is
   * why it is gated; a first name has no MCP tool and no propose path at all; the only
   * caller is the person's own browser session, so there is no untrusted caller for a
   * gate to catch.
   */
  setFirstName(actor: Actor, firstName: string): Promise<Item>;

  /**
   * Unresolved disagreements in rooms the actor can reach.
   *
   * Shown in the same queue as proposals, because it is the same act — a person being
   * asked to decide something a model is not allowed to decide — and a second inbox is a
   * second thing nobody opens.
   */
  listDisputes(actor: Actor): Promise<Dispute[]>;

  /**
   * Settles a disagreement by naming the side that stands.
   *
   * Only the author of the losing side or an owner of the room may call it, and no model
   * may: there is no MCP tool for this and there will not be one. The loser is superseded
   * by the winner through the ordinary path, so there is still exactly one way for
   * something to leave the current state.
   *
   * There is no timeout and no automatic winner. A disagreement nobody cares to settle
   * goes on being shown as a disagreement.
   */
  resolveDispute(
    actor: Actor,
    input: { winnerShortId: ShortId; loserShortId: ShortId; roomId?: RoomId; resolution?: string },
  ): Promise<Item>;
}

// ---------------------------------------------------------------------------
// Projection: profile, brief, bundle
// ---------------------------------------------------------------------------

export interface ProjectionPort {
  /**
   * The personal profile, always rendered whole and never searched. Hard ceiling at
   * PROFILE_TOKEN_BUDGET; items beyond it are demoted to the searchable archive by
   * salience, so the ceiling is a design constraint rather than a truncation bug.
   */
  buildProfile(personId: PersonId): Promise<Profile>;
  getProfile(personId: PersonId): Promise<Profile>;

  buildBrief(roomId: RoomId): Promise<Brief>;
  getBrief(actor: Actor, roomId: RoomId): Promise<Brief>;

  /**
   * Builds one room's headline, summarising the room when its owner never described it.
   *
   * The job path, and the only method here allowed to call the model. A headline is read
   * on every session and written a few times a month, so it is built when the room
   * changes rather than when someone looks.
   */
  buildHeadline(roomId: RoomId): Promise<RoomHeadline>;

  /**
   * Headlines for a room list, from cache.
   *
   * Never calls the model and never waits for one: this runs inside every bundle build,
   * and a session start that blocks on summarising eleven rooms is a voice turn nobody
   * waits through. A room whose headline has not been built yet comes back with whatever
   * is cheaply true — the owner's description, or that the room is empty — and is left
   * marked stale for the job to improve.
   */
  headlinesFor(roomIds: RoomId[]): Promise<Map<RoomId, RoomHeadline>>;

  /** Marks derived state stale. Called from the write path; rebuilds happen in jobs. */
  invalidate(input: { personId?: PersonId; roomId?: RoomId }): Promise<void>;

  activeRoomContext(actor: Actor, roomId: RoomId): Promise<ActiveRoomContext>;
}

export interface BundlePort {
  /**
   * What every connected model receives at session start. Cached and versioned;
   * building this synchronously from raw items makes voice latency impossible.
   */
  build(
    actor: Actor,
    input?: { activeRoomId?: RoomId; budgetTokens?: number },
  ): Promise<ContextBundle>;

  /** The bundle rendered for a system prompt or MCP `instructions` string. */
  render(bundle: ContextBundle): string;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface RetrievalPort {
  /**
   * Hybrid lexical + vector search fused with RRF, scoped to rooms the actor can read.
   * The scope is applied inside the SQL, never as a filter over results.
   */
  search(
    actor: Actor,
    input: { query: string; roomIds?: RoomId[]; limit?: number },
  ): Promise<SearchHit[]>;

  /**
   * Active items in one room, for the room UI.
   *
   * Search needs a query and returns ranked hits (including chunks). The web client needs
   * the room's memories as a plain list — short id, kind, body — without inventing a
   * scrape of search. Membership is checked here; unreachable rooms fail closed.
   */
  listForRoom(
    actor: Actor,
    roomId: RoomId,
  ): Promise<Array<{ shortId: ShortId; kind: ItemKind; body: string }>>;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Why a document has no searchable text. `pending` means the extractor has not run yet;
 * everything else is terminal until the document is re-extracted.
 *
 * None of these fail an upload. A scanned contract with no text layer is a normal file
 * to be handed, and losing someone's document because we could not parse it is the one
 * outcome that is never acceptable — so the bytes are stored either way and this says
 * what happened to the text.
 */
export type ExtractionStatus = 'pending' | 'extracted' | 'unsupported' | 'empty' | 'failed';

/**
 * What a document is, as everything above this port sees it.
 *
 * `text` and `summary` are separate fields and never fall back to one another. `text` is
 * what we extracted from the file; `summary` is what a model wrote about it. The product
 * promise is that the original is always reachable, and a single field that sometimes
 * holds the source and sometimes holds a paraphrase is how that promise quietly stops
 * being true.
 */
export interface DocumentSummary {
  id: DocumentId;
  roomId: RoomId;
  filename: string;
  mimeType: string;
  byteSize: number;
  checksum: string;
  uploadedBy: PersonId;
  createdAt: Date;
  extraction: ExtractionStatus;
  /** Swedish, shown to the uploader. Null unless extraction failed. */
  extractionError: string | null;
  /** Swedish. Truncation and skipped pages are the uploader's business. */
  warnings: string[];
  pageCount: number | null;
  chunkCount: number;
  /** AI-generated. Null until the `summarise_document` job has run. */
  summary: string | null;
  /** When it was moved to the trash. Null for a live document. */
  deletedAt: Date | null;
  /** When it stops being recoverable. Null for a live document. */
  purgeAfter: Date | null;
}

/** Storage against the product limit. See `STORAGE_LIMIT_BYTES`. */
export interface StorageUsageReport {
  bytesUsed: number;
  limitBytes: number;
  objectCount: number;
}

export interface DocumentPort {
  /**
   * Stores the file, then extracts and chunks it.
   *
   * Refuses in this order, all three before any text is read: the actor may not write to
   * the room, the file is over `MAX_DOCUMENT_BYTES`, or the person is at their storage
   * limit. The room is a request from the caller, resolved against real memberships — a
   * room id or name a model supplied is never a grant.
   *
   * Extraction failing does not fail the upload. A scanned contract with no text layer
   * is a normal thing to be handed, and losing someone's document because we could not
   * parse it is the one outcome that is never acceptable. The result says what happened
   * to the text; the bytes are safe either way.
   */
  upload(
    actor: Actor,
    input: { roomId: RoomId; filename: string; mimeType: string; bytes: Uint8Array },
  ): Promise<{ documentId: DocumentId; extraction: ExtractionStatus; chunkCount: number }>;

  get(actor: Actor, documentId: DocumentId): Promise<DocumentSummary | null>;
  listForRoom(actor: Actor, roomId: RoomId): Promise<DocumentSummary[]>;
  chunksFor(actor: Actor, documentId: DocumentId): Promise<Array<{ id: ChunkId; ord: number; text: string }>>;

  /**
   * The text we extracted, verbatim. Null when there is none.
   *
   * Separate from `get` because it is unbounded: a summary belongs on a card, a
   * 400-page contract does not, and a list endpoint that sometimes carries one is a
   * list endpoint that sometimes times out.
   */
  originalText(actor: Actor, documentId: DocumentId): Promise<string | null>;

  /**
   * The original bytes.
   *
   * The floor under everything else here. Summaries can be wrong, extraction can fail,
   * chunk boundaries can change — and none of it matters as long as the file a person
   * uploaded is still the file they get back.
   */
  download(
    actor: Actor,
    documentId: DocumentId,
  ): Promise<{ filename: string; mimeType: string; bytes: Uint8Array } | null>;

  storageUsage(actor: Actor): Promise<StorageUsageReport>;

  /**
   * Moves a document to the trash.
   *
   * Soft delete with the same thirty days memories get, and for the same reason: a person
   * who has just deleted the wrong contract must be able to get it back. There was no way
   * to delete a single document at all before this, which meant a failed upload or a file
   * sent to the wrong room was permanent and invisible — the person could see it and could
   * not do anything about it.
   *
   * The storage charge is *not* released here. It is released at the purge, because until
   * then the document is restorable, and a restore that failed at the storage limit would
   * make the trash a lie.
   */
  remove(
    actor: Actor,
    documentId: DocumentId,
    options?: { reason?: string },
  ): Promise<DocumentSummary | null>;

  /** Takes it back out of the trash, with its id, its chunks and its original intact. */
  restore(actor: Actor, documentId: DocumentId): Promise<DocumentSummary | null>;

  /** What is in the trash and until when, so a person can see what is recoverable. */
  trashed(actor: Actor, input?: { roomId?: RoomId; limit?: number }): Promise<DocumentSummary[]>;

  /**
   * Deletes documents past their thirty days: rows, chunks, storage charge and bytes.
   *
   * Called by the `purge_documents` job, never from a request — expiry is not an action
   * anyone takes. The bytes go only when nothing else references them: content addressing
   * means one object can belong to several people's documents.
   */
  purgeExpired(limit?: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

/**
 * `IngestPort.forget` puts things here; this reads and reverses it.
 *
 * Separate from ingest because it has a different audience. Ingest is the write path a
 * model drives; this is the safety net a person reaches for, and it has to keep working
 * even when every other assumption about the write path turns out to be wrong.
 */
/** What came back out of the trash, in the shape of whatever it was. */
export type TrashRestored =
  | { type: 'memory'; item: Item }
  | { type: 'document'; document: DocumentSummary };

export interface TrashPort {
  /**
   * Everything in this person's trash, memories and documents together, newest first.
   *
   * One list rather than two endpoints, because "where did the thing I deleted go" is one
   * question. Both halves derive from the same lifecycle events in the log, so a
   * delete-undo-delete sequence has one answer here for a file exactly as it does for a
   * memory.
   */
  list(actor: Actor, input?: { roomId?: RoomId; limit?: number }): Promise<TrashEntry[]>;

  /**
   * By handle rather than undo token, for restoring something deleted long ago.
   *
   * A `TrashHandle` and not a `ShortId`, because the trash now holds two kinds of thing and
   * they are named differently. `trashHandleOf` reads one out of a path segment, which is
   * what lets a caller restore what it is looking at without branching first.
   */
  restore(actor: Actor, handle: TrashHandle, roomId?: RoomId): Promise<TrashRestored>;

  /**
   * Permanently deletes whatever is past its deadline, and redacts the text from the
   * event log so the promise is actually kept. Called by the `purge_trash` job, never
   * from a request, and never with a person's id: expiry is not an action anyone takes.
   *
   * One shape covering both, with a document-only step inside it: a blob cannot be deleted
   * by the SQL function that is the only code permitted to redact `app.event`, so the bytes
   * go from TypeScript after the row does. That asymmetry is real rather than untidy —
   * moving the purge out of that function, or leaving orphaned bytes in storage, are both
   * worse than a step that only one kind of entry needs.
   */
  purgeExpired(limit?: number): Promise<number>;

  /** Lets a person empty it early, which some people will want before they trust us. */
  purgeNow(actor: Actor, handle: TrashHandle, roomId?: RoomId): Promise<void>;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * The visible half of "seamless".
 *
 * Saving silently is what makes the product feel effortless, and it is also what makes
 * it feel uncontrollable if nothing records it. This port is the other side of that
 * bargain: everything a model did without asking is here, attributed and reversible.
 */
export interface HistoryPort {
  list(
    actor: Actor,
    input?: { roomId?: RoomId; since?: Date; limit?: number },
  ): Promise<HistoryEntry[]>;

  /** The answer to "how do you know that about me?". */
  provenance(actor: Actor, shortId: ShortId, roomId?: RoomId): Promise<Provenance | null>;

  /**
   * Every value a memory has held, following supersede links across items.
   *
   * `provenance` answers this for one `app.item`, which is not the same question: a
   * correction does not edit the old memory, it writes a new one and supersedes the old,
   * so the previous value lives on a different row under a different short id. Give this
   * *any* short id in a chain — the current one or a long-superseded one — and it
   * resolves the chain it belongs to.
   *
   * **A chain is only ever returned for a head that is currently `active` and readable.**
   * That is the whole safety property of this method and it is deliberately enforced
   * here, in the storage query, rather than left to a caller: the steps contain text a
   * person has since replaced, and the one thing that must not happen is a superseded
   * body resurfacing for a memory that has since been deleted. A head in the trash, or
   * purged, or in a room the actor cannot read, returns nothing at all — not an empty
   * chain, no entry. `memoryChanges` in `changes.ts` refuses the same case again for the
   * same reason, because one reason is not enough for a leak that has been fixed twice.
   *
   * Order is by `lastChangedAt`, most recently changed first.
   */
  changes(
    actor: Actor,
    shortIds: ShortId[],
    input?: { limit?: number },
  ): Promise<MemoryChange[]>;
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

export interface EventPort {
  append(input: {
    roomId: RoomId;
    eventType: string;
    payload: Record<string, unknown>;
    actorPersonId?: PersonId;
    agentClient?: AgentClient;
    clientId?: string;
    sessionRef?: string;
    approvedBy?: PersonId;
    /** Why this happened here. See `deriveMotivation` for what fills it in otherwise. */
    motivation?: string;
    /** True when a person asked for it in so many words. */
    explicit?: boolean;
    source?: MemorySource;
    /** Set on moves and shares, so the day can say where it came from. */
    fromRoomId?: RoomId;
    toRoomId?: RoomId;
  }): Promise<MemoryEvent>;

  /** Replaying this is how every projection gets rebuilt when its format changes. */
  replay(input: { roomId?: RoomId; fromSeq?: number; limit?: number }): Promise<MemoryEvent[]>;

  since(actor: Actor, roomId: RoomId, seq: number): Promise<MemoryEvent[]>;
}

// ---------------------------------------------------------------------------
// Calendar: the log, read as time
// ---------------------------------------------------------------------------

/**
 * The calendar.
 *
 * Not a second store and not a summary: every method here is a query over `app.event`,
 * which is why an event cannot be missing from the calendar and cannot say something
 * different there than it does in the history. The calendar answers a question the rest
 * of the product cannot — not "what do you know about me" but "vad gjorde Photographic
 * med det jag berättade?", which is a question about a day.
 *
 * Days only, deliberately. Week, month and year are derivable from the same log at any
 * point, and building the summaries before the thing being summarised existed would have
 * meant shipping four screens of averages over one screen of facts.
 */
export interface CalendarPort {
  /**
   * Every memory event for one local day, oldest first.
   *
   * `roomId` narrows it to one room, which is the view an owner of a shared room actually
   * needs: nothing gates incoming material from the other members, so the only thing
   * standing between a room and a contribution nobody noticed is a day that shows it
   * plainly.
   */
  day(actor: Actor, input: { date: string; timeZone?: string; roomId?: RoomId }): Promise<CalendarDay>;

  /**
   * One event, zoomed: how the memory got here, every value it has held, and the source
   * it came from. This is the middle and last step of dag -> minneshändelse -> källa.
   */
  event(actor: Actor, seq: EventSeq, input?: { timeZone?: string }): Promise<MemoryEventDetail | null>;
}

// ---------------------------------------------------------------------------
// Sessions and the delivery health signal
// ---------------------------------------------------------------------------

export interface SessionPort {
  start(input: {
    personId: PersonId;
    agentClient: AgentClient;
    transport: Transport;
  }): Promise<ClientSession>;

  /**
   * Records that the profile actually reached the model, and how. We cannot force
   * every client to read the personal room, so we measure it and show the user a green
   * or red light per client. Transparency is the only honest promise available.
   */
  recordDelivery(
    sessionId: SessionId,
    method: DeliveryMethod,
    profileVersion: number,
  ): Promise<void>;

  health(actor: Actor): Promise<
    Array<{
      agentClient: AgentClient;
      lastSeenAt: Date;
      profileDelivered: boolean;
      deliveryMethod: DeliveryMethod | null;
    }>
  >;
}

// ---------------------------------------------------------------------------
// Outbound effects
// ---------------------------------------------------------------------------

/**
 * Everything that costs money or calls a model sits behind this. The fake in
 * `@photographic/core/testing` is deterministic so the whole suite runs offline
 * and free; only integration tests use the real one.
 */
export interface LlmPort {
  embed(texts: string[]): Promise<number[][]>;

  /**
   * Who computes `embed`, so it can be written down next to what it computed.
   *
   * A person asking "hur vet du det om mig?" is entitled to reach the fact that their
   * text was sent to a model, and that fact is a property of the provider rather than of
   * the memory — so it has to come from here rather than be guessed by the caller. It is
   * recorded on `app.item` at the moment the vector is written, by both the write-path
   * job and the backfill.
   *
   * `external: false` is a real answer and not a missing one: the deterministic fake
   * computes vectors in-process, so nothing left the server, and recording that is what
   * lets the backfill find memories whose vectors came from the fake and redo them
   * against a real model.
   *
   * Optional so that adding a provider does not mean editing every implementation. An
   * implementation that does not answer gets no provenance written, which is an honest
   * gap rather than a confident guess.
   */
  embeddingIdentity?(): { provider: string; model: string; external: boolean };

  /** Pulls durable, reusable facts out of a passage. Returns [] when there are none. */
  extractFacts(input: { text: string; existing: string[] }): Promise<
    Array<{ body: string; kind: ItemKind; confidence: number }>
  >;

  /** Decides whether a candidate restates, contradicts or is unrelated to an existing item. */
  compare(a: string, b: string): Promise<'same' | 'contradicts' | 'unrelated'>;

  /**
   * Confirms or rejects a room the router already shortlisted. Never proposes one.
   *
   * Optional on purpose, and the asymmetry is the point. The shortlist is computed from
   * text without a model, so routing works identically against the deterministic fake, an
   * unconfigured process and a provider outage — the feature is not invisible in the
   * environment it is tested in. When a model is available it can only make the outcome
   * *more* private, which means neither an outage nor a model talked into something by a
   * document it read can cause a memory to reach people it should not.
   *
   * `because` is shown to the person as the reason their memory stayed private, so it is
   * a short Swedish sentence rather than a debug string.
   */
  confirmPlacement?(input: {
    text: string;
    roomTitle: string;
    roomHeadline: string;
  }): Promise<{ belongs: boolean; because?: string }>;

  /**
   * Compresses text for a model to read later.
   *
   * `as` picks what kind of compression, and the two are not interchangeable. A
   * `briefing` says what the notes contain, which is what a document summary and a room
   * brief are for. A `headline` says what the thing *is* — one sentence naming a room's
   * subject and purpose, which is what belongs in a list of rooms a model skims before
   * deciding which one to open. Summarising the contents at headline length produces the
   * latest few facts with no indication of what the room is for, which reads like an
   * answer and is not one.
   */
  summarise(input: {
    texts: string[];
    budgetTokens: number;
    as?: 'briefing' | 'headline';
  }): Promise<string>;
}

export interface NotifyPort {
  sendInvite(input: {
    channel: 'email' | 'sms';
    destination: string;
    inviterName: string;
    roomTitle: string;
    url: string;
  }): Promise<void>;
}

export interface JobPort {
  enqueue(input: {
    kind: string;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    runAfter?: Date;
  }): Promise<void>;

  work(kind: string, handler: (payload: Record<string, unknown>) => Promise<void>): void;
  runOnce(): Promise<number>;
}

export interface AuditPort {
  record(input: {
    actor: Actor;
    roomId?: RoomId;
    action: 'read' | 'search' | 'write' | 'delete' | 'bundle';
    itemIds?: ItemId[];
    detail?: Record<string, unknown>;
  }): Promise<void>;
}

/** Everything wired together. Adapters receive exactly this and nothing else. */
export interface Services {
  identity: IdentityPort;
  rooms: RoomPort;
  invites: InvitePort;
  ingest: IngestPort;
  projection: ProjectionPort;
  bundle: BundlePort;
  retrieval: RetrievalPort;
  documents: DocumentPort;
  trash: TrashPort;
  history: HistoryPort;
  events: EventPort;
  calendar: CalendarPort;
  sessions: SessionPort;
  llm: LlmPort;
  notify: NotifyPort;
  jobs: JobPort;
  audit: AuditPort;
}
