/**
 * `RoomPort`: rooms, membership and the name a person actually speaks.
 */

import {
  NotPermittedError,
  ValidationError,
  type Actor,
  type MemberRole,
  type Person,
  type PersonId,
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

    const [unseen, oneLines, members] = await Promise.all([
      this.deps.store.readState.unseenCounts(actor.personId, roomIds),
      this.deps.text?.oneLineFor(roomIds) ?? Promise.resolve(new Map<RoomId, string>()),
      this.deps.store.memberships.countsForRooms(roomIds),
    ]);

    return rows
      .map(({ room, role }) => ({
        roomId: room.id,
        slug: room.slug,
        title: room.title,
        kind: room.kind,
        role,
        oneLine: oneLines.get(room.id)?.trim() || firstLine(room.description),
        // Never below one: the person reading the list is a member of every room in it,
        // so a zero here would be a dropped row rather than an empty room.
        memberCount: Math.max(1, members.get(room.id) ?? 0),
        unseenCount: unseen.get(room.id) ?? 0,
      }))
      .sort(byPersonalThenTitle);
  }

  /**
   * Editors may describe a room, not only its owner.
   *
   * The room's sentence is the kind of thing whoever works in the room is best placed to
   * get right, and a wrong one is visible to everyone and trivially corrected — unlike
   * archiving, which is why that stays with the owner.
   */
  async describe(actor: Actor, roomId: RoomId, description: string | null): Promise<Room> {
    const { room } = await requireRole(
      this.deps.store,
      actor,
      roomId,
      'editor',
      'bara medlemmar som får skriva kan beskriva rummet',
    );

    const trimmed = description?.trim() || null;
    if (trimmed === room.description) return room;

    const updated = await this.deps.store.rooms.setDescription(room.id, trimmed);
    await this.deps.store.events.append({
      roomId: room.id,
      eventType: 'room.described',
      payload: { description: trimmed },
      ...provenanceOf(actor),
    });

    return updated;
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
   * Leaves a shared room. The membership ends; the contributions stay.
   *
   * If forty notes vanished the moment their author left, everyone else's memory would
   * change behind their backs — decisions citing her material stop making sense. So the
   * membership row is kept and only `left_at` is set, which is also what lets the room go
   * on attributing what she wrote.
   *
   * `removeContributions` is refused here rather than half-implemented. Deleting memories
   * goes through the trash, which is the ingest package's write path, and this package
   * owns no access to items by design — see the note at the top of `deps.ts`. The wired
   * implementation offers the option; this service is the membership half.
   */
  async leave(
    actor: Actor,
    roomId: RoomId,
    input: { removeContributions?: boolean } = {},
  ): Promise<void> {
    const { room } = await requireAccess(this.deps.store, actor, roomId);
    if (room.kind === 'personal') {
      throw new ValidationError('du kan inte lämna ditt eget rum');
    }
    if (input.removeContributions) {
      throw new ValidationError(
        'att ta bort egna bidrag går via papperskorgen och hanteras inte här',
      );
    }

    await this.endMembership(actor, roomId, actor.personId, null);
  }

  /** Owner-only. Never touches the removed member's contributions. */
  async removeMember(actor: Actor, roomId: RoomId, personId: PersonId): Promise<void> {
    await requireRole(
      this.deps.store,
      actor,
      roomId,
      'owner',
      'bara rummets ägare kan ta bort en medlem',
    );
    if (personId === actor.personId) {
      throw new ValidationError('använd "lämna rummet" för att gå ur själv');
    }

    const membership = await this.deps.store.memberships.find(personId, roomId);
    if (!membership || membership.leftAt !== null) {
      throw new NotPermittedError('personen är inte medlem i rummet');
    }

    await this.endMembership(actor, roomId, personId, actor.personId);
  }

  /**
   * Read state is not memory: it carries no event. Appending one would make every
   * "what happened since you were here" check itself something that happened.
   */
  async markSeen(actor: Actor, roomId: RoomId): Promise<void> {
    await requireAccess(this.deps.store, actor, roomId);
    await this.deps.store.readState.markSeen(actor.personId, roomId);
  }

  /**
   * Ends one membership and records it.
   *
   * No token revocation, and none is needed: access is the intersection of the token's
   * scope with *current* memberships, resolved per request, so it stops at the next call.
   * Caching that would be the bug.
   */
  private async endMembership(
    actor: Actor,
    roomId: RoomId,
    personId: PersonId,
    removedBy: PersonId | null,
  ): Promise<void> {
    await this.deps.store.memberships.end(personId, roomId, this.now());

    await this.deps.store.events.append({
      roomId,
      eventType: 'member.left',
      payload: {
        person_id: personId,
        ...(removedBy ? { removed_by: removedBy } : {}),
        contributions: 'kept',
      },
      ...provenanceOf(actor),
    });

    await this.succeedOwnership(actor, roomId, personId);
  }

  /**
   * A room always has an owner, or it has no reason to exist.
   *
   * The longest-serving editor inherits, as the person most likely to know what the room
   * is for. With nobody to inherit it the room is archived, which already removes it from
   * everyone's accessible rooms rather than leaving content nobody can administer.
   */
  private async succeedOwnership(
    actor: Actor,
    roomId: RoomId,
    departed: PersonId,
  ): Promise<void> {
    const active = await this.deps.store.memberships.activeInRoom(roomId);
    if (active.some((m) => m.role === 'owner')) return;

    const heir = active
      .filter((m) => m.role === 'editor')
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];

    if (heir) {
      await this.deps.store.memberships.setRole(heir.personId, roomId, 'owner');
      await this.deps.store.events.append({
        roomId,
        eventType: 'room.owner_changed',
        payload: { person_id: heir.personId, previous_owner: departed, reason: 'succession' },
        ...provenanceOf(actor),
      });
      return;
    }

    const room = await this.deps.store.rooms.findById(roomId);
    if (!room || room.archivedAt !== null) return;

    const now = this.now();
    await this.deps.store.rooms.archive(roomId, now);
    await this.deps.store.events.append({
      roomId,
      eventType: 'room.archived',
      payload: { archivedAt: now.toISOString(), reason: 'no_owner_remaining' },
      ...provenanceOf(actor),
    });
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
  const personal = (summary: RoomSummary) => (summary.kind === 'personal' ? 0 : 1);
  return personal(a) - personal(b) || a.title.localeCompare(b.title, 'sv');
}
