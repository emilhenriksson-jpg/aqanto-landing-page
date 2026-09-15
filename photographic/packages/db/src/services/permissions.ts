/**
 * Permission resolution, delegated to the database function of the same name.
 *
 * `app.accessible_room_ids` is the single choke point the schema comment insists on.
 * Reimplementing the join here instead of calling the function would be exactly the
 * second place to be wrong that the SQL comment warns against.
 */

import type { MemberRole, PersonId, RoomId } from '@photographic/core';
import { NotPermittedError } from '@photographic/core';

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

/**
 * Refused for a frozen account. Not an error the person caused; a state they chose.
 *
 * Defined here, beside the other permission checks, rather than in `account.ts`: this is
 * the file everything that writes already imports for `canWrite`, and `account.ts`
 * appends events through `events.ts`, which itself imports `canRead` from here — so the
 * reverse import would be a cycle. `account.ts` re-exports this for compatibility, since
 * it is the module the public error type has always been imported from.
 */
export class AccountFrozenError extends NotPermittedError {
  constructor() {
    super(
      'Kontot är på väg att raderas och går inte att skriva till. Avbryt raderingen först.',
    );
  }
}

/**
 * Whether this person has an open deletion request. See `AccountFrozenError` and
 * `PgAccounts.isFrozen` for the fuller reasoning: a frozen account may still read,
 * export and cancel, but every write in the product funnels through `assertCanWrite` or
 * `assertNotFrozen` below, which is what makes the freeze real rather than aspirational.
 */
export async function isFrozen(db: Db, personId: PersonId): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM app.account_deletion WHERE person_id = $1 AND status = 'requested'`,
    [personId],
  );
  return row !== null;
}

/** Throws `AccountFrozenError` for a person mid-deletion. Checked first, always. */
export async function assertNotFrozen(db: Db, personId: PersonId): Promise<void> {
  if (await isFrozen(db, personId)) throw new AccountFrozenError();
}

/**
 * The one gate every write path calls before touching a room.
 *
 * Frozen first, room permission second: a stranger poking at someone else's room should
 * still see the room-permission refusal (404-shaped `NotPermittedError`), not a message
 * that leaks whether the *target* account happens to be mid-deletion.
 */
export async function assertCanWrite(db: Db, personId: PersonId, roomId: RoomId): Promise<void> {
  await assertNotFrozen(db, personId);
  if (!(await canWrite(db, personId, roomId))) throw new NotPermittedError();
}
