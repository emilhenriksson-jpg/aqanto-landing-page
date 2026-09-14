/**
 * `RoomPort`: rooms, membership and the name a person actually speaks.
 */

import {
  NotPermittedError,
  ValidationError,
  type Actor,
  type MemberRole,
  type Person,
  type Room,
  type RoomId,
  type RoomPort,
  type RoomSummary,
} from '@photographic/core';

import { createRoom } from './create-room.js';
import type { RoomsDeps } from './deps.js';
import { provenanceOf, requireAccess, requireRole, withinScope } from './permission.js';
import { foldName } from './slug.js';

export class RoomService implements RoomPort {
  constructor(private readonly deps: RoomsDeps) {}

  async create(actor: Actor, input: { title: string; description?: string }): Promise<Room> {
    return this.deps.transaction((tx) =>
      createRoom(tx, {
        kind: 'shared',
        title: input.title,
        description: input.description ?? null,
        owner: actor.personId,
        provenance: provenanceOf(actor),
      }),
    );
  }

  /**
   * Throws rather than returning `null` for a room the actor cannot reach, so that a
   * room which exists and a room which does not are indistinguishable from outside.
   */
  async get(actor: Actor, roomId: RoomId): Promise<Room | null> {
    const { room } = await requireAccess(this.deps.store, actor, roomId);
    return room;
  }

  async listForPerson(actor: Actor): Promise<RoomSummary[]> {
    const rows = withinScope(actor, await this.deps.store.rooms.accessibleRooms(actor.personId));
    const roomIds = rows.map((row) => row.room.id);

    const [unseen, oneLines] = await Promise.all([
      this.deps.store.readState.unseenCounts(actor.personId, roomIds),
      this.deps.text?.oneLineFor(roomIds) ?? Promise.resolve(new Map<RoomId, string>()),
    ]);

    return rows
      .map(({ room, role }) => ({
        roomId: room.id,
        slug: room.slug,
        title: room.title,
        role,
        oneLine: oneLines.get(room.id)?.trim() || firstLine(room.description),
        unseenCount: unseen.get(room.id) ?? 0,
      }))
      .sort(byPersonalThenTitle);
  }

  async archive(actor: Actor, roomId: RoomId): Promise<void> {
    const { room } = await requireRole(
      this.deps.store,
      actor,
      roomId,
      'owner',
      'bara rummets ägare kan arkivera det',
    );

    if (room.kind === 'personal') {
      throw new ValidationError('det personliga rummet kan inte arkiveras');
    }
    if (room.archivedAt !== null) return;

    const now = this.now();
    await this.deps.store.rooms.archive(room.id, now);
    await this.deps.store.events.append({
      roomId: room.id,
      eventType: 'room.archived',
      payload: { archivedAt: now.toISOString() },
      ...provenanceOf(actor),
    });
  }

  /**
   * Resolves a name a person spoke to a room they can reach.
   *
   * Exact matches on title or slug win; only when nothing matches exactly does a
   * contained match count, so "Ledning" never beats a room actually called "Ledning".
   * Several candidates is a question, not a guess: picking one and writing a memory
   * into the wrong shared room is unrecoverable, so it throws and names them.
   */
  async resolveByName(actor: Actor, name: string): Promise<Room | null> {
    const wanted = foldName(name);
    if (wanted.length === 0) throw new ValidationError('ange ett rumsnamn');

    const rows = withinScope(actor, await this.deps.store.rooms.accessibleRooms(actor.personId));
    const candidates = rows.map(({ room }) => ({
      room,
      title: foldName(room.title),
      slug: foldName(room.slug),
    }));

    const exact = candidates.filter((c) => c.title === wanted || c.slug === wanted);
    if (exact.length > 0) return single(exact, name);

    const contained = candidates.filter((c) => c.title.includes(wanted) || c.slug.includes(wanted));
    if (contained.length > 0) return single(contained, name);

    return null;
  }

  async members(actor: Actor, roomId: RoomId): Promise<Array<{ person: Person; role: MemberRole }>> {
    await requireAccess(this.deps.store, actor, roomId);
    return this.deps.store.memberships.listForRoom(roomId);
  }

  /**
   * Read state is not memory: it carries no event. Appending one would make every
   * "what happened since you were here" check itself something that happened.
   */
  async markSeen(actor: Actor, roomId: RoomId): Promise<void> {
    await requireAccess(this.deps.store, actor, roomId);
    await this.deps.store.readState.markSeen(actor.personId, roomId);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

function single(candidates: Array<{ room: Room }>, spoken: string): Room {
  const [first] = candidates;
  if (candidates.length === 1 && first) return first.room;

  const names = candidates
    .map((c) => c.room.title)
    .sort((a, b) => a.localeCompare(b, 'sv'))
    .join(', ');
  throw new ValidationError(`flera rum matchar "${spoken}": ${names}. Vilket menar du?`);
}

function firstLine(description: string | null): string {
  if (!description) return '';
  return description.split('\n')[0]?.trim() ?? '';
}

/** The personal room is always first: it is the room a person means by default. */
function byPersonalThenTitle(a: RoomSummary, b: RoomSummary): number {
  return a.title.localeCompare(b.title, 'sv');
}
