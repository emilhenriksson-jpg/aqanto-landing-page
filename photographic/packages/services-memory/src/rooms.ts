/**
 * Rooms and membership.
 */

import type {
  Actor,
  MemberRole,
  Person,
  Room,
  RoomId,
  RoomPort,
  RoomSummary,
} from '@photographic/core';
import { NotPermittedError } from '@photographic/core';

import { slugify } from './identity.js';
import { MemoryStore, newId } from './store.js';

/** The one-line summary shown when a room is listed rather than opened. */
function oneLineFor(store: MemoryStore, roomId: RoomId): string {
  const room = store.rooms.get(roomId);
  if (room?.description) return room.description;

  // Falling back to the most recent memory rather than to "empty room" means the list
  // reads like the rooms actually do, which is what makes a model able to pick the
  // right one from a spoken name.
  const recent = store
    .itemsInRoom(roomId)
    .filter((i) => i.status === 'active')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (!recent) return 'Inget sparat än';
  return recent.body.length > 120 ? `${recent.body.slice(0, 117)}...` : recent.body;
}

export class MemoryRooms implements RoomPort {
  constructor(private readonly store: MemoryStore) {}

  async create(actor: Actor, input: { title: string; description?: string }): Promise<Room> {
    const title = input.title.trim();
    if (!title) throw new NotPermittedError('Rummet måste ha ett namn.');

    const room: Room = {
      id: newId<RoomId>(),
      kind: 'shared',
      slug: slugify(title),
      title,
      description: input.description ?? null,
      sensitivity: 'normal',
      createdBy: actor.personId,
      createdAt: this.store.now(),
      archivedAt: null,
    };
    this.store.rooms.set(room.id, room);
    this.store.addMembership({ personId: actor.personId, roomId: room.id, role: 'owner' });

    this.store.append({
      roomId: room.id,
      eventType: 'room.created',
      payload: { title: room.title, kind: 'shared' },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    return room;
  }

  /**
   * Returns null rather than throwing on a room the actor cannot reach.
   *
   * Same reason `NotPermittedError` renders as 404: a distinguishable "exists but not
   * yours" tells you something about someone else's rooms.
   */
  async get(actor: Actor, roomId: RoomId): Promise<Room | null> {
    if (!this.store.canRead(actor.personId, roomId)) return null;
    return this.store.rooms.get(roomId) ?? null;
  }

  async listForPerson(actor: Actor): Promise<RoomSummary[]> {
    const summaries = this.store.accessibleRoomIds(actor.personId).map((roomId) => {
      const room = this.store.rooms.get(roomId)!;
      return {
        roomId,
        slug: room.slug,
        title: room.title,
        role: this.store.roleIn(actor.personId, roomId) ?? 'viewer',
        oneLine: oneLineFor(this.store, roomId),
        unseenCount: this.unseenCount(actor, roomId),
      } satisfies RoomSummary;
    });

    // Personal room first: it is the one a person means when they do not say a name.
    return summaries.sort((a, b) => {
      const ap = this.store.rooms.get(a.roomId)?.kind === 'personal' ? 0 : 1;
      const bp = this.store.rooms.get(b.roomId)?.kind === 'personal' ? 0 : 1;
      return ap - bp || a.title.localeCompare(b.title, 'sv');
    });
  }

  async archive(actor: Actor, roomId: RoomId): Promise<void> {
    if (this.store.roleIn(actor.personId, roomId) !== 'owner') throw new NotPermittedError();
    const room = this.store.rooms.get(roomId);
    if (!room) throw new NotPermittedError();
    if (room.kind === 'personal') {
      throw new NotPermittedError('Det personliga rummet kan inte arkiveras.');
    }
    room.archivedAt = this.store.now();
  }

  /**
   * Resolves a spoken name to a room.
   *
   * People say "lägg det i Buyersclub Ledning", not a UUID, so this has to tolerate
   * case, punctuation and partial names. It only ever searches rooms the actor already
   * belongs to, which is what keeps a fuzzy match from becoming a way to discover other
   * people's room names by guessing.
   */
  async resolveByName(actor: Actor, name: string): Promise<Room | null> {
    const needle = slugify(name);
    if (!needle) return null;

    const candidates = this.store
      .accessibleRoomIds(actor.personId)
      .map((id) => this.store.rooms.get(id)!)
      .filter(Boolean);

    return (
      candidates.find((r) => r.slug === needle) ??
      candidates.find((r) => slugify(r.title) === needle) ??
      candidates.find((r) => slugify(r.title).startsWith(needle)) ??
      candidates.find((r) => slugify(r.title).includes(needle)) ??
      null
    );
  }

  async members(
    actor: Actor,
    roomId: RoomId,
  ): Promise<Array<{ person: Person; role: MemberRole }>> {
    if (!this.store.canRead(actor.personId, roomId)) throw new NotPermittedError();

    return this.store.memberships
      .filter((m) => m.roomId === roomId && m.leftAt === null)
      .map((m) => ({ person: this.store.persons.get(m.personId)!, role: m.role }))
      .filter((x) => x.person !== undefined);
  }

  async markSeen(actor: Actor, roomId: RoomId): Promise<void> {
    if (!this.store.canRead(actor.personId, roomId)) throw new NotPermittedError();
    const latest = this.store.allEvents().filter((e) => e.roomId === roomId).at(-1);
    this.store.readState.set(`${actor.personId}:${roomId}`, latest?.seq ?? 0);
  }

  private unseenCount(actor: Actor, roomId: RoomId): number {
    const seen = this.store.readState.get(`${actor.personId}:${roomId}`) ?? 0;
    return this.store
      .allEvents()
      .filter((e) => e.roomId === roomId && e.seq > seen && e.actorPersonId !== actor.personId)
      .length;
  }
}
