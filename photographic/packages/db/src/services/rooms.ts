/**
 * Rooms and membership, backed by Postgres.
 */

import type {
  Actor,
  MemberRole,
  Person,
  ProjectionPort,
  Room,
  RoomId,
  RoomPort,
  RoomSummary,
} from '@photographic/core';
import { NotPermittedError } from '@photographic/core';
import type { Pool } from 'pg';

import { execute, queryOne, queryRows } from '../pool.js';
import { mapPerson, mapRoom, type PersonRow, type RoomRow } from '../rows.js';
import { slugify } from '../slug.js';
import { appendEvent } from './events.js';
import { accessibleRoomIds, canRead, canWrite, roleIn } from './permissions.js';

export class PgRooms implements RoomPort {
  constructor(
    private readonly pool: Pool,
    private readonly projection: Pick<ProjectionPort, 'headlinesFor' | 'invalidate'>,
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
}
