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
  ChunkId,
  ClientSession,
  ContextBundle,
  DeliveryMethod,
  DocumentId,
  Invite,
  InviteId,
  Item,
  ItemId,
  ItemKind,
  MemberRole,
  HistoryEntry,
  MemoryEvent,
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
} from './domain.js';

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

  accept(token: string, personId: PersonId): Promise<{ room: Room; role: MemberRole }>;
  revoke(actor: Actor, inviteId: InviteId): Promise<void>;
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
  | { outcome: 'auto'; item: Item }
  | { outcome: 'needs_approval'; proposal: Proposal }
  | { outcome: 'duplicate'; existing: Item };

export interface IngestPort {
  remember(
    actor: Actor,
    input: {
      roomId: RoomId;
      body: string;
      kind?: ItemKind;
      sensitivity?: 'normal' | 'sensitive';
      /** Set by the caller when the human explicitly asked for this write. */
      explicit?: boolean;
    },
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
    },
  ): Promise<Proposal>;

  update(actor: Actor, shortId: ShortId, roomId: RoomId, body: string): Promise<Item>;

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
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface DocumentPort {
  upload(
    actor: Actor,
    input: { roomId: RoomId; filename: string; mimeType: string; bytes: Uint8Array },
  ): Promise<{ documentId: DocumentId }>;

  get(actor: Actor, documentId: DocumentId): Promise<{ filename: string; summary: string | null } | null>;
  listForRoom(actor: Actor, roomId: RoomId): Promise<Array<{ id: DocumentId; filename: string }>>;
  chunksFor(actor: Actor, documentId: DocumentId): Promise<Array<{ id: ChunkId; ord: number; text: string }>>;
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
export interface TrashPort {
  list(actor: Actor, input?: { roomId?: RoomId; limit?: number }): Promise<TrashEntry[]>;

  /** By short id rather than undo token, for restoring something deleted long ago. */
  restore(actor: Actor, shortId: ShortId, roomId?: RoomId): Promise<Item>;

  /**
   * Permanently deletes whatever is past its deadline, and redacts the text from the
   * event log so the promise is actually kept. Called by the `purge_trash` job, never
   * from a request, and never with a person's id: expiry is not an action anyone takes.
   */
  purgeExpired(limit?: number): Promise<number>;

  /** Lets a person empty it early, which some people will want before they trust us. */
  purgeNow(actor: Actor, shortId: ShortId, roomId?: RoomId): Promise<void>;
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
    sessionRef?: string;
    approvedBy?: PersonId;
  }): Promise<MemoryEvent>;

  /** Replaying this is how every projection gets rebuilt when its format changes. */
  replay(input: { roomId?: RoomId; fromSeq?: number; limit?: number }): Promise<MemoryEvent[]>;

  since(actor: Actor, roomId: RoomId, seq: number): Promise<MemoryEvent[]>;
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

  /** Pulls durable, reusable facts out of a passage. Returns [] when there are none. */
  extractFacts(input: { text: string; existing: string[] }): Promise<
    Array<{ body: string; kind: ItemKind; confidence: number }>
  >;

  /** Decides whether a candidate restates, contradicts or is unrelated to an existing item. */
  compare(a: string, b: string): Promise<'same' | 'contradicts' | 'unrelated'>;

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
  sessions: SessionPort;
  llm: LlmPort;
  notify: NotifyPort;
  jobs: JobPort;
  audit: AuditPort;
}
