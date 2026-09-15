/**
 * Permission resolution, delegated to the database function of the same name.
 *
 * `app.accessible_room_ids` is the single choke point the schema comment insists on.
 * Reimplementing the join here instead of calling the function would be exactly the
 * second place to be wrong that the SQL comment warns against.
 */

import type { MemberRole, PersonId, RoomId } from '@photographic/core';

import { queryOne, queryRows, type Db } from '../pool.js';

export async function accessibleRoomIds(db: Db, personId: PersonId): Promise<RoomId[]> {
  const rows = await queryRows<{ room_id: string }>(
    db,
    `SELECT room_id FROM app.accessible_room_ids($1)`,
    [personId],
  );
  return rows.map((r) => r.room_id as RoomId);
}

export async function roleIn(db: Db, personId: PersonId, roomId: RoomId): Promise<MemberRole | null> {
  const row = await queryOne<{ role: MemberRole }>(
    db,
    `SELECT role FROM app.accessible_room_ids($1) WHERE room_id = $2`,
    [personId, roomId],
  );
  return row?.role ?? null;
}

export async function canRead(db: Db, personId: PersonId, roomId: RoomId): Promise<boolean> {
  const row = await queryOne<{ can: boolean }>(
    db,
    `SELECT app.can_read_room($1, $2) AS can`,
    [personId, roomId],
  );
  return row?.can ?? false;
}

export async function canWrite(db: Db, personId: PersonId, roomId: RoomId): Promise<boolean> {
  const row = await queryOne<{ can: boolean }>(
    db,
    `SELECT app.can_write_room($1, $2) AS can`,
    [personId, roomId],
  );
  return row?.can ?? false;
}
