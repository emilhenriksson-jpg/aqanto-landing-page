import type { Actor, Room } from '@photographic/core';
import { NotPermittedError, privateRoomTitle, ValidationError } from '@photographic/core';
import type { Db } from '../pool.js';
import { queryOne, queryRows, withTransaction } from '../pool.js';
import { mapRoom, type RoomRow } from '../rows.js';
import { slugify } from '../slug.js';
import { appendEvent } from './events.js';
import { assertNotFrozen } from './permissions.js';

export async function assertPrivateRoom(db: Db, actor: Actor, roomId: string): Promise<Room> {
  const row = await queryOne<RoomRow>(db, `SELECT r.* FROM app.room r
    JOIN app.membership m ON m.room_id = r.id AND m.person_id = $1 AND m.left_at IS NULL
    WHERE r.id = $2 AND r.created_by = $1 AND m.role = 'owner' AND r.archived_at IS NULL
      AND (cardinality($3::uuid[]) = 0 OR r.id = ANY($3::uuid[])) FOR UPDATE OF r`,
  [actor.personId, roomId, actor.roomScope]);
  if (!row) throw new NotPermittedError();
  const others = await queryOne(db, `SELECT 1 FROM app.membership
    WHERE room_id = $1 AND person_id <> $2 AND left_at IS NULL
      AND room_id IN (SELECT room_id FROM app.accessible_room_ids($2)) LIMIT 1`, [roomId, actor.personId]);
  if (others) throw new ValidationError('Rummet delas med andra. Det här godkännandet gäller bara privata rum.');
  return mapRoom(row);
}

/** The room, owner membership and creation event commit together. */
export async function createPrivateRoom(db: Db, actor: Actor,
  input: { title: string; description?: string; reusePrivate?: boolean }): Promise<Room> {
  if (actor.roomScope.length) throw new NotPermittedError('En rumsbegränsad koppling kan inte skapa nya rum.');
  const title = privateRoomTitle(input.title);
  if (!title || title.length > 200 || (input.description?.length ?? 0) > 2000) {
    throw new ValidationError('Ange ett rumsnamn på högst 200 tecken och en beskrivning på högst 2000 tecken.');
  }
  return withTransaction(db, async tx => {
    await assertNotFrozen(tx, actor.personId);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`rooms:${actor.personId}`]);
    if (input.reusePrivate) {
      const rows = await queryRows<RoomRow>(tx, `SELECT r.* FROM app.room r
        JOIN app.membership m ON m.room_id = r.id AND m.person_id = $1 AND m.left_at IS NULL
        WHERE r.archived_at IS NULL`, [actor.personId]);
      const matches = rows.filter(row => privateRoomTitle(row.title).toLocaleLowerCase('sv') === title.toLocaleLowerCase('sv'));
      if (matches.length > 1) throw new ValidationError('Flera rum har samma namn. Välj ett tydligare namn.');
      if (matches[0]) {
        const existing = await assertPrivateRoom(tx, actor, matches[0].id);
        if (privateRoomTitle(existing.title).toLocaleLowerCase('sv') !== title.toLocaleLowerCase('sv')) {
          throw new ValidationError('Rumsnamnet ändrades under tiden. Läs rumsöversikten igen.');
        }
        return existing;
      }
    }
    const row = await queryOne<RoomRow>(tx, `INSERT INTO app.room (kind, slug, title, description, created_by)
      VALUES ('shared', $1, $2, $3, $4) RETURNING *`, [slugify(title), title, input.description?.trim() || null, actor.personId]);
    const room = mapRoom(row!);
    await tx.query(`INSERT INTO app.membership (person_id, room_id, role) VALUES ($1, $2, 'owner')`, [actor.personId, room.id]);
    await appendEvent(tx, { roomId: room.id, eventType: 'room.created', payload: { title, kind: 'shared' },
      actorPersonId: actor.personId, agentClient: actor.agentClient, clientId: actor.clientId ?? null,
      sessionRef: actor.sessionId });
    return room;
  });
}
