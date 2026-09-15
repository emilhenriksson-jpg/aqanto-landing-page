/**
 * Rooms and membership, backed by Postgres.
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
import { NotPermittedError } from '@photographic/core';
import type { Pool } from 'pg';

import { execute, queryOne, queryRows, withTransaction } from '../pool.js';
import {
  ITEM_COLUMNS,
  mapItem,
  mapPerson,
  mapRoom,
  type ItemRow,
  type PersonRow,
  type RoomRow,
} from '../rows.js';
import { slugify } from '../slug.js';
import { appendEvent } from './events.js';
import type { PgIngest } from './ingest.js';
import { accessibleRoomIds, canRead, canWrite, roleIn } from './permissions.js';

export class PgRooms implements RoomPort {
  constructor(
    private readonly pool: Pool,
    private readonly projection: Pick<ProjectionPort, 'headlinesFor' | 'invalidate'>,
    /** Leaving a room can take the author's own contributions with it, through the trash. */
    private readonly ingest: Pick<PgIngest, 'softDelete'>,
  ) {}

  async create(actor: Actor, input: { title: string; description?: string }): Promise<Room> {
    const title = input.title.trim();
    if (!title) throw new NotPermittedError('Rummet måste ha ett namn.');

    const row = await queryOne<RoomRow>(
      this.pool,
      `INSERT INTO app.room (kind, slug, title, description, created_by)
       VALUES ('shared', $1, $2, $3, $4)
       RETURNING id, kind, slug, title, description, sensitivity, created_by, created_at, archived_at`,
      [slugify(title), title, input.description ?? null, actor.personId],
    );
    const room = mapRoom(row!);

    await execute(
      this.pool,
      `INSERT INTO app.membership (person_id, room_id, role) VALUES ($1, $2, 'owner')`,
      [actor.personId, room.id],
    );

    await appendEvent(this.pool, {
      roomId: room.id,
      eventType: 'room.created',
      payload: { title: room.title, kind: 'shared' },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    return room;
  }

  async get(actor: Actor, roomId: RoomId): Promise<Room | null> {
    if (!(await canRead(this.pool, actor.personId, roomId))) return null;
    const row = await queryOne<RoomRow>(
      this.pool,
      `SELECT id, kind, slug, title, description, sensitivity, created_by, created_at, archived_at
       FROM app.room WHERE id = $1`,
      [roomId],
    );
    return row ? mapRoom(row) : null;
  }

  async listForPerson(actor: Actor): Promise<RoomSummary[]> {
    const roomIds = await accessibleRoomIds(this.pool, actor.personId);
    if (roomIds.length === 0) return [];

    const headlines = await this.projection.headlinesFor(roomIds);

    const rows = await queryRows<
      RoomRow & { role: MemberRole; member_count: string; unseen_count: string }
    >(
      this.pool,
      `SELECT r.id, r.kind, r.slug, r.title, r.description, r.sensitivity, r.created_by,
              r.created_at, r.archived_at,
              m.role,
              (SELECT count(*) FROM app.membership mc WHERE mc.room_id = r.id AND mc.left_at IS NULL) AS member_count,
              (SELECT count(*) FROM app.event e
               WHERE e.room_id = r.id
                 AND e.seq > coalesce((SELECT last_seen_seq FROM app.room_read_state rs
                                        WHERE rs.person_id = $1 AND rs.room_id = r.id), 0)
                 AND (e.actor_person_id IS NULL OR e.actor_person_id <> $1)) AS unseen_count
       FROM app.room r
       JOIN app.membership m ON m.room_id = r.id AND m.person_id = $1 AND m.left_at IS NULL
       WHERE r.id = ANY($2::uuid[]) AND r.archived_at IS NULL`,
      [actor.personId, roomIds],
    );

    const summaries = rows.map((row) => {
      const room = mapRoom(row);
      return {
        roomId: room.id,
        slug: room.slug,
        title: room.title,
        kind: room.kind,
        role: row.role,
        oneLine: headlines.get(room.id)?.rendered ?? '',
        memberCount: Number(row.member_count),
        unseenCount: Number(row.unseen_count),
      } satisfies RoomSummary;
    });

    return summaries.sort((a, b) => {
      const ap = a.kind === 'personal' ? 0 : 1;
      const bp = b.kind === 'personal' ? 0 : 1;
      return ap - bp || a.title.localeCompare(b.title, 'sv');
    });
  }

  async describe(actor: Actor, roomId: RoomId, description: string | null): Promise<Room> {
    const role = await roleIn(this.pool, actor.personId, roomId);
    if (role !== 'owner' && role !== 'editor') throw new NotPermittedError();

    const trimmed = description?.trim() || null;
    const row = await queryOne<RoomRow>(
      this.pool,
      `UPDATE app.room SET description = $1 WHERE id = $2
       RETURNING id, kind, slug, title, description, sensitivity, created_by, created_at, archived_at`,
      [trimmed, roomId],
    );
    if (!row) throw new NotPermittedError();
    const room = mapRoom(row);

    await appendEvent(this.pool, {
      roomId,
      eventType: 'room.described',
      payload: { description: room.description },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    await this.projection.invalidate({ roomId });
    return room;
  }

  async archive(actor: Actor, roomId: RoomId): Promise<void> {
    const role = await roleIn(this.pool, actor.personId, roomId);
    if (role !== 'owner') throw new NotPermittedError();

    const room = await this.get(actor, roomId);
    if (!room) throw new NotPermittedError();
    if (room.kind === 'personal') {
      throw new NotPermittedError('Det personliga rummet kan inte arkiveras.');
    }

    await execute(this.pool, `UPDATE app.room SET archived_at = now() WHERE id = $1`, [roomId]);
  }

  async resolveByName(actor: Actor, name: string): Promise<Room | null> {
    const needle = slugify(name);
    if (!needle) return null;

    const roomIds = await accessibleRoomIds(this.pool, actor.personId);
    if (roomIds.length === 0) return null;

    const rows = await queryRows<RoomRow>(
      this.pool,
      `SELECT id, kind, slug, title, description, sensitivity, created_by, created_at, archived_at
       FROM app.room WHERE id = ANY($1::uuid[])`,
      [roomIds],
    );
    const candidates = rows.map(mapRoom);

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
    if (!(await canRead(this.pool, actor.personId, roomId))) throw new NotPermittedError();

    const rows = await queryRows<PersonRow & { role: MemberRole }>(
      this.pool,
      `SELECT p.id, p.handle, p.display_name, p.email, p.phone, p.locale, p.created_at, m.role
       FROM app.membership m
       JOIN app.person p ON p.id = m.person_id
       WHERE m.room_id = $1 AND m.left_at IS NULL`,
      [roomId],
    );
    return rows.map((row) => ({ person: mapPerson(row), role: row.role }));
  }

  /**
   * Leaves a shared room. The membership ends; the contributions stay.
   *
   * See `MemoryRooms.leave` for the reasoning. Mechanically: `left_at` is set rather than
   * the row being deleted, so the room keeps knowing who wrote what, and `member.left`
   * goes into the log in the same transaction. No token revocation, because access is the
   * intersection of the token's scope with *current* memberships on every request.
   */
  async leave(
    actor: Actor,
    roomId: RoomId,
    input: { removeContributions?: boolean } = {},
  ): Promise<void> {
    const role = await roleIn(this.pool, actor.personId, roomId);
    if (!role) throw new NotPermittedError();

    const room = await this.require(roomId);
    if (room.kind === 'personal') {
      throw new NotPermittedError('Du kan inte lämna ditt eget rum.');
    }

    await this.endMembership(actor, roomId, actor.personId, {
      removeContributions: input.removeContributions ?? false,
      removedBy: null,
    });
  }

  /** Owner-only. Never touches the removed member's contributions. */
  async removeMember(actor: Actor, roomId: RoomId, personId: PersonId): Promise<void> {
    if ((await roleIn(this.pool, actor.personId, roomId)) !== 'owner') throw new NotPermittedError();
    if (!(await roleIn(this.pool, personId, roomId))) throw new NotPermittedError();
    if (personId === actor.personId) {
      throw new NotPermittedError('Använd "lämna rummet" för att gå ur själv.');
    }

    await this.endMembership(actor, roomId, personId, {
      removeContributions: false,
      removedBy: actor.personId,
    });
  }

  async markSeen(actor: Actor, roomId: RoomId): Promise<void> {
    if (!(await canRead(this.pool, actor.personId, roomId))) throw new NotPermittedError();

    const latest = await queryOne<{ seq: string }>(
      this.pool,
      `SELECT max(seq) AS seq FROM app.event WHERE room_id = $1`,
      [roomId],
    );
    const seq = latest?.seq ? Number(latest.seq) : 0;

    await execute(
      this.pool,
      `INSERT INTO app.room_read_state (person_id, room_id, last_seen_seq, last_seen_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (person_id, room_id)
       DO UPDATE SET last_seen_seq = $3, last_seen_at = now()`,
      [actor.personId, roomId, seq],
    );
  }

  private async endMembership(
    actor: Actor,
    roomId: RoomId,
    personId: PersonId,
    options: { removeContributions: boolean; removedBy: PersonId | null },
  ): Promise<void> {
    if (options.removeContributions) {
      // Through the ordinary trash: visible to the other members as `item.deleted` with a
      // motivation, and undoable by an owner for thirty days. A silent mass deletion of
      // somebody's contributions is precisely what the log exists to make impossible.
      const own = await queryRows<ItemRow>(
        this.pool,
        `SELECT ${ITEM_COLUMNS} FROM app.item
         WHERE room_id = $1 AND author_person_id = $2 AND status = 'active'`,
        [roomId, personId],
      );

      for (const row of own) {
        await this.ingest.softDelete(
          actor,
          mapItem(row),
          'borttaget av författaren när hon lämnade rummet',
        );
      }
    }

    await withTransaction(this.pool, async (tx) => {
      await tx.query(
        `UPDATE app.membership SET left_at = now()
         WHERE room_id = $1 AND person_id = $2 AND left_at IS NULL`,
        [roomId, personId],
      );

      await appendEvent(tx, {
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
    });

    await this.succeedOwnership(actor, roomId, personId);
    await this.projection.invalidate({ roomId });
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
    const heir = await queryOne<{ person_id: string }>(
      this.pool,
      `SELECT person_id FROM app.membership
       WHERE room_id = $1 AND left_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM app.membership o
           WHERE o.room_id = $1 AND o.left_at IS NULL AND o.role = 'owner'
         )
         AND role = 'editor'
       ORDER BY joined_at ASC
       LIMIT 1`,
      [roomId],
    );

    if (heir) {
      await execute(
        this.pool,
        `UPDATE app.membership SET role = 'owner' WHERE room_id = $1 AND person_id = $2`,
        [roomId, heir.person_id],
      );
      await appendEvent(this.pool, {
        roomId,
        eventType: 'room.owner_changed',
        payload: { person_id: heir.person_id, previous_owner: departed, reason: 'succession' },
        actorPersonId: actor.personId,
        agentClient: actor.agentClient,
        motivation: 'Rummets ägare lämnade. Ägarskapet gick till den editor som varit med längst.',
      });
      return;
    }

    const remaining = await queryOne<{ owners: string }>(
      this.pool,
      `SELECT count(*) AS owners FROM app.membership
       WHERE room_id = $1 AND left_at IS NULL AND role = 'owner'`,
      [roomId],
    );
    if (Number(remaining?.owners ?? 0) > 0) return;

    const archived = await execute(
      this.pool,
      `UPDATE app.room SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
      [roomId],
    );
    if (archived === 0) return;

    await appendEvent(this.pool, {
      roomId,
      eventType: 'room.archived',
      payload: { reason: 'no_owner_remaining' },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      motivation: 'Ingen ägare kvar i rummet.',
    });
  }

  private async require(roomId: RoomId): Promise<Room> {
    const row = await queryOne<RoomRow>(
      this.pool,
      `SELECT id, kind, slug, title, description, sensitivity, created_by, created_at, archived_at
       FROM app.room WHERE id = $1`,
      [roomId],
    );
    if (!row) throw new NotPermittedError();
    return mapRoom(row);
  }
}
