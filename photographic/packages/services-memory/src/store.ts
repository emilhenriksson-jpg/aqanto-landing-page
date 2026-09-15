/**
 * The tables, in memory.
 *
 * This package is the reference implementation of every port. It exists because the
 * ports were written before anything implemented them, and a set of interfaces nobody
 * has satisfied is a guess about whether they can be satisfied at all. Writing this
 * first turns the acceptance test from a wish into a thing that runs, and it gives the
 * Postgres implementation a definition of correct behaviour to match rather than a
 * paragraph of prose to interpret.
 *
 * The structures deliberately mirror `0001_init.sql` and `0002_trash_and_history.sql`
 * one-to-one, including the parts that are inconvenient here: events are append-only,
 * room access is resolved through membership on every read rather than cached on the
 * actor, and a purge redacts event payloads instead of deleting rows. Anywhere this
 * file takes a shortcut the database cannot, the two implementations would diverge the
 * first time someone relies on the shortcut.
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentClient,
  Brief,
  ChunkId,
  ClientSession,
  DocumentId,
  EventSeq,
  Invite,
  InviteId,
  Item,
  ItemId,
  MemberRole,
  Membership,
  MemoryEvent,
  MemorySource,
  Person,
  PersonId,
  Profile,
  Proposal,
  ProposalId,
  Room,
  RoomHeadline,
  RoomId,
  SessionId,
  ShortId,
} from '@photographic/core';
import { NotPermittedError } from '@photographic/core';

export interface DocumentRow {
  id: DocumentId;
  roomId: RoomId;
  filename: string;
  mimeType: string;
  byteSize: number;
  text: string;
  summary: string | null;
  uploadedBy: PersonId;
  uploadedAt: Date;
}

export interface ChunkRow {
  id: ChunkId;
  documentId: DocumentId;
  roomId: RoomId;
  ord: number;
  text: string;
  embedding: number[] | null;
}

/** An invite plus the token, which the schema stores hashed and never returns. */
export interface InviteRow {
  invite: Invite;
  token: string;
  url: string;
}

export function newId<T extends string>(): T {
  return randomUUID() as T;
}

/**
 * Everything, in one object.
 *
 * A single mutable store rather than one per service, because the services are not
 * independent: ingest writes items that projection reads and history explains. Splitting
 * the state would only move the coupling somewhere less visible.
 */
export class MemoryStore {
  readonly persons = new Map<PersonId, Person>();
  readonly rooms = new Map<RoomId, Room>();
  readonly memberships: Membership[] = [];
  readonly items = new Map<ItemId, Item>();
  readonly proposals = new Map<ProposalId, Proposal>();
  readonly invites = new Map<InviteId, InviteRow>();
  readonly sessions = new Map<SessionId, ClientSession>();
  readonly documents = new Map<DocumentId, DocumentRow>();
  readonly chunks = new Map<ChunkId, ChunkRow>();

  /** Cached projections. Rebuilt by jobs, never synchronously on the write path. */
  readonly profiles = new Map<PersonId, Profile>();
  readonly briefs = new Map<RoomId, Brief>();
  readonly headlines = new Map<RoomId, RoomHeadline>();

  /** Item embeddings, kept beside the item as `app.item.embedding` does. */
  readonly embeddings = new Map<ItemId, number[]>();

  /** `${personId}:${roomId}` -> last seen event seq, mirroring `room_read_state`. */
  readonly readState = new Map<string, number>();

  /** Undo tokens, as `app.item.undo_token`. */
  readonly undoTokens = new Map<string, ItemId>();

  /**
   * The log. Append-only: the only mutation permitted anywhere is redaction during a
   * purge, exactly as the `reject_event_mutation` trigger allows.
   */
  private readonly events: MemoryEvent[] = [];

  /** Injected so tests can move time without waiting for it. */
  now: () => Date = () => new Date();

  // -------------------------------------------------------------------------
  // The event log
  // -------------------------------------------------------------------------

  append(input: {
    roomId: RoomId;
    eventType: string;
    payload: Record<string, unknown>;
    actorPersonId?: PersonId | null;
    agentClient?: AgentClient | null;
    clientId?: string | null;
    sessionRef?: string | null;
    approvedBy?: PersonId | null;
    motivation?: string | null;
    explicit?: boolean;
    source?: MemorySource | null;
    fromRoomId?: RoomId | null;
    toRoomId?: RoomId | null;
  }): MemoryEvent {
    const event: MemoryEvent = {
      seq: (this.events.length + 1) as EventSeq,
      id: randomUUID(),
      roomId: input.roomId,
      eventType: input.eventType,
      payload: { ...input.payload },
      actorPersonId: input.actorPersonId ?? null,
      agentClient: input.agentClient ?? null,
      clientId: input.clientId ?? null,
      sessionRef: input.sessionRef ?? null,
      approvedBy: input.approvedBy ?? null,
      occurredAt: this.now(),
      motivation: input.motivation?.trim() || null,
      explicit: input.explicit ?? false,
      source: input.source ?? null,
      fromRoomId: input.fromRoomId ?? null,
      toRoomId: input.toRoomId ?? null,
    };
    this.events.push(event);
    return event;
  }

  /** Copies, so a caller cannot mutate the log by holding on to what it read. */
  allEvents(): MemoryEvent[] {
    return this.events.map((e) => ({ ...e, payload: { ...e.payload } }));
  }

  eventsForItem(itemId: ItemId): MemoryEvent[] {
    return this.allEvents().filter((e) => e.payload['item_id'] === itemId);
  }

  /**
   * The one permitted mutation, and the reason it is a named method rather than
   * `events[i].payload = ...` at the call site: in Postgres this requires setting a
   * session flag the trigger checks, so it has to be just as deliberate here.
   */
  redactItemText(itemIds: ItemId[]): void {
    const targets = new Set<string>(itemIds);
    for (const event of this.events) {
      if (targets.has(String(event.payload['item_id']))) {
        const {
          body: _b,
          text: _t,
          structured: _s,
          excerpt: _e,
          // What the memory used to say. An edit keeps both values on purpose, so a
          // purge has to take both or the trash kept half a promise.
          previous: _p,
          ...rest
        } = event.payload;
        event.payload = { ...rest, redacted: true, redacted_at: this.now() };
        event.motivation = null;
        continue;
      }

      // A correction quotes what it replaced, on the *new* memory's event. Purging the
      // old one therefore has to reach an event that is not about it — surgically, because
      // the new memory's own text is still live.
      if (targets.has(String(event.payload['supersedes'])) && 'previous' in event.payload) {
        const { previous: _p, ...rest } = event.payload;
        event.payload = { ...rest, previous_redacted: true };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle, read out of the log
  // -------------------------------------------------------------------------

  /**
   * The last thing that happened to an item, out of the log rather than out of a column.
   *
   * What is in the trash is a question about the log: an item whose most recent lifecycle
   * event was a deletion and which has not been restored or purged since. Deriving it
   * fixes a class of bug rather than one bug — a delete-undo-delete sequence has one
   * answer here and cannot have two.
   */
  lastLifecycleEvent(itemId: ItemId): MemoryEvent | null {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const event = this.events[i]!;
      if (event.payload['item_id'] !== itemId) continue;
      if (
        event.eventType === 'item.deleted' ||
        event.eventType === 'item.restored' ||
        event.eventType === 'item.purged'
      ) {
        return event;
      }
    }
    return null;
  }

  /** True when the log says this item is sitting in the trash right now. */
  isInTrash(itemId: ItemId): boolean {
    return this.lastLifecycleEvent(itemId)?.eventType === 'item.deleted';
  }

  // -------------------------------------------------------------------------
  // Room isolation
  // -------------------------------------------------------------------------

  /**
   * Nothing lands in a shared room unless a person put it there.
   *
   * The same rule as the `item_shared_placement_explicit` trigger in migration 0003, and
   * here for the same reason it is there: a model deciding a private fact belongs in a
   * room five people read is not a recoverable mistake. Policy refuses it first; this
   * refuses it again, at the point of storage, where no future write path can skip it.
   */
  assertPlacementAllowed(roomId: RoomId, placementExplicit: boolean): void {
    if (placementExplicit) return;
    if (this.rooms.get(roomId)?.kind !== 'shared') return;

    throw new NotPermittedError(
      'Automatik får inte lägga minnen i ett delat rum. Delning är alltid en uttrycklig handling.',
    );
  }

  // -------------------------------------------------------------------------
  // Permission resolution
  // -------------------------------------------------------------------------

  /**
   * The single source of truth for what a person can reach.
   *
   * Every read goes through this. A room id that arrives in a tool call is a request to
   * be checked, never a grant, and the check belongs here so there is one place to be
   * wrong rather than fifteen.
   */
  accessibleRoomIds(personId: PersonId): RoomId[] {
    return this.memberships
      .filter((m) => m.personId === personId && m.leftAt === null)
      .map((m) => m.roomId)
      .filter((id) => {
        const room = this.rooms.get(id);
        return room !== undefined && room.archivedAt === null;
      });
  }

  roleIn(personId: PersonId, roomId: RoomId): MemberRole | null {
    const m = this.memberships.find(
      (x) => x.personId === personId && x.roomId === roomId && x.leftAt === null,
    );
    return m?.role ?? null;
  }

  canRead(personId: PersonId, roomId: RoomId): boolean {
    return this.roleIn(personId, roomId) !== null;
  }

  canWrite(personId: PersonId, roomId: RoomId): boolean {
    const role = this.roleIn(personId, roomId);
    return role === 'owner' || role === 'editor';
  }

  personalRoomIdOf(personId: PersonId): RoomId | null {
    for (const roomId of this.accessibleRoomIds(personId)) {
      if (this.rooms.get(roomId)?.kind === 'personal') return roomId;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Item lookup
  // -------------------------------------------------------------------------

  itemsInRoom(roomId: RoomId): Item[] {
    return [...this.items.values()].filter((i) => i.roomId === roomId);
  }

  /**
   * Resolves a short id within the rooms the actor can reach.
   *
   * Scoped rather than global because short ids are only four characters: they are
   * unique enough to address one of a person's own memories unambiguously, and not
   * unique enough to be safe as a global handle.
   */
  findByShortId(personId: PersonId, shortId: ShortId, roomId?: RoomId): Item | null {
    const scope = roomId ? [roomId] : this.accessibleRoomIds(personId);
    const allowed = new Set(scope.filter((id) => this.canRead(personId, id)));

    for (const item of this.items.values()) {
      if (item.shortId === shortId && allowed.has(item.roomId)) return item;
    }
    return null;
  }

  put(item: Item, placementExplicit = false): Item {
    this.assertPlacementAllowed(item.roomId, placementExplicit);
    this.items.set(item.id, item);
    return item;
  }

  addMembership(input: {
    personId: PersonId;
    roomId: RoomId;
    role: MemberRole;
    invitedBy?: PersonId | null;
  }): Membership {
    const existing = this.memberships.find(
      (m) => m.personId === input.personId && m.roomId === input.roomId,
    );
    if (existing) {
      existing.leftAt = null;
      existing.role = input.role;
      return existing;
    }

    const membership: Membership = {
      personId: input.personId,
      roomId: input.roomId,
      role: input.role,
      invitedBy: input.invitedBy ?? null,
      joinedAt: this.now(),
      leftAt: null,
    };
    this.memberships.push(membership);
    return membership;
  }
}
