/**
 * The trash, backed by Postgres. Purging calls `app.purge_expired_items`, the one
 * function permitted to redact `app.event` -- reimplementing the redaction here instead
 * would mean maintaining the append-only exception in two places.
 */

import type {
  Actor,
  Item,
  PersonId,
  ProjectionPort,
  RoomId,
  ShortId,
  TrashEntry,
  TrashPort,
} from '@photographic/core';
import { NotFoundError, NotPermittedError } from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows } from '../pool.js';
import { mapItem, mapTrashEntry, type ItemRow, type TrashEntryRow } from '../rows.js';
import { appendEvent } from './events.js';
import type { PgIngest } from './ingest.js';
import { accessibleRoomIds, canRead, canWrite } from './permissions.js';

export const DEFAULT_PURGE_LIMIT = 500;

const ITEM_COLUMNS = `id, short_id, room_id, kind, body, structured, sensitivity, status,
  valid_from, valid_to, superseded_by, salience, token_estimate, last_used_at, use_count,
  created_at, deleted_at, deleted_by, deleted_by_client, purge_after, delete_reason`;

const ITEM_COLUMNS_PREFIXED = `i.id, i.short_id, i.room_id, i.kind, i.body, i.structured, i.sensitivity,
  i.status, i.valid_from, i.valid_to, i.superseded_by, i.salience, i.token_estimate,
  i.last_used_at, i.use_count, i.created_at, i.deleted_at, i.deleted_by, i.deleted_by_client,
  i.purge_after, i.delete_reason`;

export class PgTrash implements TrashPort {
  constructor(
    private readonly pool: Pool,
    private readonly ingest: PgIngest,
    private readonly projection: ProjectionPort,
  ) {}

  async list(actor: Actor, input: { roomId?: RoomId; limit?: number } = {}): Promise<TrashEntry[]> {
    const scope = input.roomId
      ? (await canRead(this.pool, actor.personId, input.roomId)) ? [input.roomId] : []
      : await accessibleRoomIds(this.pool, actor.personId);
    if (scope.length === 0) return [];

    const rows = await queryRows<TrashEntryRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS_PREFIXED}, r.title AS room_title
       FROM app.item i
       JOIN app.room r ON r.id = i.room_id
       WHERE i.room_id = ANY($1::uuid[]) AND i.status = 'deleted'
       ORDER BY i.deleted_at DESC
       LIMIT $2`,
      [scope, input.limit ?? 50],
    );

    const now = new Date();
    return rows.map((row) => mapTrashEntry(row, now));
  }

  async restore(actor: Actor, shortId: ShortId, roomId?: RoomId): Promise<Item> {
    const item = await this.findByShortId(actor.personId, shortId, roomId);
    if (!item || item.status !== 'deleted') throw new NotFoundError('Det finns inget att återställa.');
    if (!(await canWrite(this.pool, actor.personId, item.roomId))) throw new NotPermittedError();

    return this.ingest.restore(actor, item);
  }

  async purgeExpired(limit = DEFAULT_PURGE_LIMIT): Promise<number> {
    const due = await queryRows<ItemRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS} FROM app.item
       WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after <= now()
       ORDER BY purge_after ASC
       LIMIT $1`,
      [limit],
    );
    if (due.length === 0) return 0;

    const items = due.map(mapItem);

    for (const item of items) {
      await appendEvent(this.pool, {
        roomId: item.roomId,
        eventType: 'item.purged',
        payload: { item_id: item.id, short_id: item.shortId },
        actorPersonId: item.deletedBy,
        agentClient: item.deletedByClient,
      });
    }

    // The database function is the only code permitted to redact `app.event`; it also
    // deletes the `app.item` rows in the same statement.
    await this.pool.query('SELECT app.purge_expired_items($1)', [limit]);

    await this.invalidateAfterPurge(items);
    return items.length;
  }

  async purgeNow(actor: Actor, shortId: ShortId, roomId?: RoomId): Promise<void> {
    const item = await this.findByShortId(actor.personId, shortId, roomId);
    if (!item || item.status !== 'deleted') throw new NotFoundError('Det finns inget att radera.');
    if (!(await canWrite(this.pool, actor.personId, item.roomId))) throw new NotPermittedError();

    await appendEvent(this.pool, {
      roomId: item.roomId,
      eventType: 'item.purged',
      payload: { item_id: item.id, short_id: item.shortId },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    await this.pool.query(
      `UPDATE app.item SET purge_after = now() WHERE id = $1`,
      [item.id],
    );
    await this.pool.query('SELECT app.purge_expired_items($1)', [1]);
    await this.invalidateAfterPurge([item]);
  }

  private async findByShortId(personId: PersonId, shortId: ShortId, roomId?: RoomId): Promise<Item | null> {
    const scope = roomId ? [roomId] : await accessibleRoomIds(this.pool, personId);
    if (scope.length === 0) return null;

    const row = await queryOne<ItemRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS} FROM app.item WHERE short_id = $1 AND room_id = ANY($2::uuid[])`,
      [shortId, scope],
    );
    return row ? mapItem(row) : null;
  }

  private async invalidateAfterPurge(items: Item[]): Promise<void> {
    const rooms = new Set<RoomId>();
    const persons = new Set<PersonId>();

    for (const item of items) {
      rooms.add(item.roomId);
    }

    if (rooms.size > 0) {
      const roomRows = await queryRows<{ id: string; kind: string; created_by: string }>(
        this.pool,
        `SELECT id, kind, created_by FROM app.room WHERE id = ANY($1::uuid[])`,
        [[...rooms]],
      );
      for (const room of roomRows) {
        if (room.kind === 'personal') persons.add(room.created_by as PersonId);
      }
    }

    for (const roomId of rooms) await this.projection.invalidate({ roomId });
    for (const personId of persons) await this.projection.invalidate({ personId });
  }
}
