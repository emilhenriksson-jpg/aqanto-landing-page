/**
 * What `@photographic/rooms` needs from the outside world.
 *
 * The services here own permission resolution, slugging, tokens and the event trail.
 * They own no SQL. Everything that touches storage goes through the narrow stores
 * below, which `@photographic/db` satisfies and which `InMemoryStore` satisfies for
 * tests, so this package is testable without a database.
 *
 * Two contracts matter more than the rest when wiring the real repositories:
    10| *
 *  - `RoomStore.accessRole` and `RoomStore.accessibleRooms` must be the *same* query
 *    as `app.accessible_room_ids`: active membership, room not archived. They are the
 *    only place access is decided, so a divergence between them is a leak.
 *  - `InviteStore` never sees a raw token. It stores and looks up a SHA-256 hash.
 */

import type {
  AgentClient,
  Invite,
    20|  InviteId,
  InviteStatus,
  MemberRole,
  Membership,
  MemoryEvent,
  NotifyPort,
  Person,
  PersonId,
  Room,
  RoomId,
    30|  RoomKind,
  Sensitivity,
} from '@photographic/core';

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface PersonInsert {
  displayName: string | null;
    40|  email: string | null;
  phone: string | null;
  locale: string;
}

export interface PersonStore {
  /**
   * Inserts a person. Must reject a duplicate live email or phone with
   * `ConflictError`, mirroring `person_email_key` / `person_phone_key`.
   */
  create(input: PersonInsert): Promise<Person>;
    50|  findById(id: PersonId): Promise<Person | null>;
  findByEmail(email: string): Promise<Person | null>;
  findByPhone(phone: string): Promise<Person | null>;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export interface RoomInsert {
    60|  kind: RoomKind;
  slug: string;
  title: string;
  description: string | null;
  sensitivity: Sensitivity;
  createdBy: PersonId;
}

export interface RoomStore {
  /**
   * Inserts a room. Must reject a second personal room for the same person with
    70|   * `ConflictError`, mirroring `room_one_personal_per_person`.
   */
  create(input: RoomInsert): Promise<Room>;

  /** Unfiltered lookup. Callers must resolve access before exposing the result. */
  findById(id: RoomId): Promise<Room | null>;

  /** Slugs are globally unique by convention so an invite URL can carry one. */
  slugTaken(slug: string): Promise<boolean>;

    80|  personalRoomOf(personId: PersonId): Promise<Room | null>;

  archive(id: RoomId, at: Date): Promise<void>;

  /** Mirrors `app.accessible_room_ids`: active membership, room not archived. */
  accessibleRooms(personId: PersonId): Promise<Array<{ room: Room; role: MemberRole }>>;

  /** The same query as `accessibleRooms`, narrowed to one room. `null` means no access. */
  accessRole(personId: PersonId, roomId: RoomId): Promise<MemberRole | null>;
}
    90|
// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export interface MembershipInsert {
  personId: PersonId;
  roomId: RoomId;
  role: MemberRole;
  invitedBy: PersonId | null;
}
   100|
export interface MembershipStore {
  /** Includes memberships the person has left, so `accept` can revive one. */
  find(personId: PersonId, roomId: RoomId): Promise<Membership | null>;

  /**
   * Upsert. An existing active membership keeps its role — accepting an editor
   * invite must never demote an owner. A membership that was left is revived.
   */
  add(input: MembershipInsert): Promise<Membership>;

   110|  listForRoom(roomId: RoomId): Promise<Array<{ person: Person; role: MemberRole }>>;
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export interface InviteInsert {
  roomId: RoomId;
  invitedBy: PersonId;
   120|  channel: 'email' | 'sms';
  destination: string;
  role: MemberRole;
  /** SHA-256 of the raw token. The raw token exists only in the sent link. */
  tokenHash: string;
  previewAllowed: boolean;
  expiresAt: Date;
}

export interface InviteStore {
  create(input: InviteInsert): Promise<Invite>;
   130|  findById(id: InviteId): Promise<Invite | null>;
  findByTokenHash(tokenHash: string): Promise<Invite | null>;
  setStatus(id: InviteId, status: InviteStatus): Promise<Invite>;
  markAccepted(id: InviteId, personId: PersonId, at: Date): Promise<Invite>;
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

   140|export interface ReadStateStore {
  /**
   * Events in each room newer than that person's `room_read_state.last_seen_seq`,
   * excluding events the person caused themselves — your own writes are not news.
   * Rooms with nothing unseen may be omitted from the map.
   */
  unseenCounts(personId: PersonId, roomIds: RoomId[]): Promise<Map<RoomId, number>>;

  /** Sets `last_seen_seq` to the room's current head sequence. */
  markSeen(personId: PersonId, roomId: RoomId): Promise<void>;
   150|}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * The append half of `EventPort`. Deliberately narrow: this package writes the trail
 * and never replays it, so a full `EventPort` satisfies this structurally.
 */
export interface EventSink {
   160|  append(input: {
    roomId: RoomId;
    eventType: string;
    payload: Record<string, unknown>;
    actorPersonId?: PersonId;
    agentClient?: AgentClient;
    sessionRef?: string;
    approvedBy?: PersonId;
  }): Promise<MemoryEvent>;
}
   170|
// ---------------------------------------------------------------------------
// The bundle of stores, and the deps around it
// ---------------------------------------------------------------------------

export interface RoomsStore {
  people: PersonStore;
  rooms: RoomStore;
  memberships: MembershipStore;
  invites: InviteStore;
  readState: ReadStateStore;
   180|  events: EventSink;
}

/**
 * Room text that lives in other packages. Optional: without it a room falls back to
 * its own description, so `@photographic/rooms` never depends on `projection`.
 */
export interface RoomTextSource {
  /** One line per room for the room list, normally taken from the brief. */
  oneLineFor(roomIds: RoomId[]): Promise<Map<RoomId, string>>;
   190|
  /** Readable preview for an invited person who may not have an account yet. */
  previewFor(roomId: RoomId): Promise<string | null>;
}

export interface RoomsConfig {
  /** Origin invite links are built from, e.g. `https://photographic.app`. */
  inviteBaseUrl: string;

  /** Overrides link construction entirely when the web app owns the route shape. */
   200|  inviteUrl?: (token: string) => string;

  /** How long a new invite stays valid. Default 14 days. */
  inviteTtlMs?: number;

  /** Provenance for `register()`, which happens before any `Actor` exists. */
  registrationClient?: AgentClient;

  /** Default for `person.locale`. Default `sv-SE`. */
  defaultLocale?: string;
   210|}

export interface RoomsDeps {
  store: RoomsStore;

  /**
   * Runs `fn` inside one transaction and rolls back if it throws. Registration
   * creates a person, their personal room and their membership in one unit; a partial
   * result there leaves a person who can never write anything.
   */
  transaction: <T>(fn: (store: RoomsStore) => Promise<T>) => Promise<T>;
   220|

  /** Invites are the only outbound effect this package has. */
  notify: NotifyPort;

  config: RoomsConfig;

  /** Injected so expiry can be tested without waiting two weeks. */
  now?: () => Date;

   230|  /** Raw invite token factory. Default: 32 random bytes, base64url. */
  newToken?: () => string;

  text?: RoomTextSource;
}

/**
 * For stores with no transaction support. Only safe where a partial write is
 * acceptable, which registration is not — use a real transaction in production.
 */
   240|export function withoutTransactions(store: RoomsStore): RoomsDeps['transaction'] {
  return (fn) => fn(store);
}
