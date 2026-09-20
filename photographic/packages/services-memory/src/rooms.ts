import { createPrivateRoom } from './private-rooms.js';
/**
 * Rooms and membership.
 */

import type {
  Actor,
  MemberRole,
  Person,
  PersonId,
  ProjectionPort,
  Room,
  RoomId,
  RoomPort,
  RoomSummary,
} from '@photographic/core';
import { matchRoomByName, NotPermittedError } from '@photographic/core';

import type { MemoryIngest } from './ingest.js';
import { MemoryStore } from './store.js';

export class MemoryRooms implements RoomPort {
  constructor(
    private readonly store: MemoryStore,
    private readonly projection: Pick<ProjectionPort, 'headlinesFor' | 'invalidate'>,
    /** Leaving a room can take the author's own contributions with it, through the trash. */
    private readonly ingest: Pick<MemoryIngest, 'softDelete'>,
  ) {}

  async create(actor: Actor, input: { title: string; description?: string; reusePrivate?: boolean }): Promise<Room> {
    return createPrivateRoom(this.store, actor, input);
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
    const roomIds = this.store.accessibleRoomIds(actor.personId);
    const headlines = await this.projection.headlinesFor(roomIds);

    const summaries = roomIds.map((roomId) => {
      const room = this.store.rooms.get(roomId)!;
      return {
        roomId,
        slug: room.slug,
        title: room.title,
        kind: room.kind,
        role: this.store.roleIn(actor.personId, roomId) ?? 'viewer',
        oneLine: headlines.get(roomId)?.rendered ?? '',
        memberCount: this.memberCount(roomId),
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

  /**
   * Editors may describe a room, not only its owner.
   *
   * The room's sentence is the kind of thing whoever works in the room is best placed to
   * get right, and a wrong one is visible to everyone and trivially corrected — unlike
   * archiving, which is why that stays with the owner.
   */
  async describe(actor: Actor, roomId: RoomId, description: string | null): Promise<Room> {
    const role = this.store.roleIn(actor.personId, roomId);
    if (role !== 'owner' && role !== 'editor') throw new NotPermittedError();

    const room = this.store.rooms.get(roomId);
    if (!room) throw new NotPermittedError();

    const trimmed = description?.trim() ?? '';
    room.description = trimmed || null;

    this.store.append({
      roomId,
      eventType: 'room.described',
      payload: { description: room.description },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    // The read path serves the owner's text straight from the room, so the overview is
    // correct on the next session without waiting for a rebuild. The invalidation is for
    // the cached copy, and for the summary this description now overrides.
    await this.projection.invalidate({ roomId });

    return room;
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
  /**
   * Exact, or a unique prefix. Never a substring — see `matchRoomByName`.
   *
   * Candidates are the rooms the actor can reach, so a name only ever selects among
   * rooms they are already in. The rule lives in `@photographic/core` so this and
   * `PgRooms` cannot answer differently.
   */
  async resolveByName(actor: Actor, name: string): Promise<Room | null> {
    const candidates = this.store
      .accessibleRoomIds(actor.personId)
      .map((id) => this.store.rooms.get(id)!)
      .filter(Boolean);

    const match = matchRoomByName(candidates, name);
    return match.matched ? match.room : null;
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

  /**
   * Leaves a shared room. The membership ends; the contributions stay.
   *
   * This is the most consequential promise in the permission model and it runs the
   * uncomfortable way round deliberately. If forty notes vanished the moment their author
   * left, everyone *else's* memory would change behind their backs — decisions citing her
   * material stop making sense, and their calendars grow holes none of them caused.
   *
   * The price is that you do not get back what you wrote into a shared room, which is
   * only acceptable because it is said beforehand and because `removeContributions`
   * exists: it goes through the ordinary trash, the other members see `item.deleted` with
   * a motivation, and an owner can undo it for thirty days. No owner can take that option
   * away, and nothing here is a silent mass deletion.
   */
  async leave(
    actor: Actor,
    roomId: RoomId,
    input: { removeContributions?: boolean } = {},
  ): Promise<void> {
    const role = this.store.roleIn(actor.personId, roomId);
    if (!role) throw new NotPermittedError();

    const room = this.store.rooms.get(roomId);
    if (!room) throw new NotPermittedError();
    if (room.kind === 'personal') {
      throw new NotPermittedError('Du kan inte lämna ditt eget rum.');
    }

    await this.endMembership(actor, roomId, actor.personId, {
      removeContributions: input.removeContributions ?? false,
      removedBy: null,
    });
  }

  /** Owner-only. Same mechanics as leaving, decided by someone else. */
  async removeMember(actor: Actor, roomId: RoomId, personId: PersonId): Promise<void> {
    if (this.store.roleIn(actor.personId, roomId) !== 'owner') throw new NotPermittedError();
    if (!this.store.roleIn(personId, roomId)) throw new NotPermittedError();
    if (personId === actor.personId) {
      throw new NotPermittedError('Använd "lämna rummet" för att gå ur själv.');
    }

    // An owner removing someone else never touches their contributions. Deciding that
    // somebody else's work should disappear is a different act, and it is the one thing
    // "remove my contributions" exists to keep in the author's own hands.
    await this.endMembership(actor, roomId, personId, {
      removeContributions: false,
      removedBy: actor.personId,
    });
  }

  async markSeen(actor: Actor, roomId: RoomId): Promise<void> {
    if (!this.store.canRead(actor.personId, roomId)) throw new NotPermittedError();
    const latest = this.store.allEvents().filter((e) => e.roomId === roomId).at(-1);
    this.store.readState.set(`${actor.personId}:${roomId}`, latest?.seq ?? 0);
  }

  /**
   * Ends one membership and records it.
   *
   * No token revocation is needed and none is done: the actor's reach is intersected
   * against *current* memberships on every request, so access stops at the next call.
   * Caching it would be the bug.
   */
  private async endMembership(
    actor: Actor,
    roomId: RoomId,
    personId: PersonId,
    options: { removeContributions: boolean; removedBy: PersonId | null },
  ): Promise<void> {
    if (options.removeContributions) {
      const own = this.store
        .itemsInRoom(roomId)
        .filter((item) => item.authorPersonId === personId && item.status === 'active');

      for (const item of own) {
        await this.ingest.softDelete(actor, item, 'borttaget av författaren när hon lämnade rummet');
      }
    }

    const membership = this.store.memberships.find(
      (m) => m.personId === personId && m.roomId === roomId && m.leftAt === null,
    );
    if (membership) membership.leftAt = this.store.now();

    this.store.append({
      roomId,
      eventType: 'member.left',
      payload: {
        person_id: personId,
        ...(options.removedBy ? { removed_by: options.removedBy } : {}),
        contributions: options.removeContributions ? 'removed' : 'kept',
      },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      explicit: true,
      motivation: options.removeContributions
        ? 'Lämnade rummet och tog bort sina egna bidrag.'
        : 'Medlemskapet upphörde. Bidragen stannar i rummet.',
    });

    await this.succeedOwnership(actor, roomId, personId);
    await this.projection.invalidate({ roomId });
  }

  /**
   * A room always has an owner, or it has no reason to exist.
   *
   * The longest-serving editor inherits, because that is the person most likely to know
   * what the room is for. With nobody to inherit it, the room is archived — which already
   * removes it from `accessibleRoomIds` for everyone rather than leaving content nobody
   * can administer.
   */
  private async succeedOwnership(actor: Actor, roomId: RoomId, departed: PersonId): Promise<void> {
    const active = this.store.memberships.filter((m) => m.roomId === roomId && m.leftAt === null);
    if (active.some((m) => m.role === 'owner')) return;

    const heir = active
      .filter((m) => m.role === 'editor')
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];

    if (heir) {
      heir.role = 'owner';
      this.store.append({
        roomId,
        eventType: 'room.owner_changed',
        payload: { person_id: heir.personId, previous_owner: departed, reason: 'succession' },
        actorPersonId: actor.personId,
        agentClient: actor.agentClient,
        explicit: false,
        motivation: 'Rummets ägare lämnade. Ägarskapet gick till den editor som varit med längst.',
      });
      return;
    }

    const room = this.store.rooms.get(roomId);
    if (room && room.archivedAt === null) {
      room.archivedAt = this.store.now();
      this.store.append({
        roomId,
        eventType: 'room.archived',
        payload: { reason: 'no_owner_remaining' },
        actorPersonId: actor.personId,
        agentClient: actor.agentClient,
        motivation: 'Ingen ägare kvar i rummet.',
      });
    }
  }

  private memberCount(roomId: RoomId): number {
    return this.store.memberships.filter((m) => m.roomId === roomId && m.leftAt === null).length;
  }

  private unseenCount(actor: Actor, roomId: RoomId): number {
    const seen = this.store.readState.get(`${actor.personId}:${roomId}`) ?? 0;
    return this.store
      .allEvents()
      .filter((e) => e.roomId === roomId && e.seq > seen && e.actorPersonId !== actor.personId)
      .length;
  }
}
