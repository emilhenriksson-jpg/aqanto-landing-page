/**
 * The trash, backed by Postgres — memories and documents in one surface.
 *
 * Two things used to be true here and only one of them should have been. The trash was
 * derived from the log, which is right and is what gives delete-undo-delete a single answer.
 * And it held only memories, while a deleted document lived in a parallel listing with its
 * own endpoint, its own restore and its own purge. That second half was a reasonable thing to
 * build at the time — this view derives from item lifecycle *events*, and the transactional
 * path that guarantees a document's events exist landed afterwards — and it is not a
 * reasonable thing to keep. A person who deleted something looks in one place.
 *
 * So `list` reads one view, `restore` and `purgeNow` take a `TrashHandle`, and purging is one
 * method with a document-only step inside it. That last asymmetry is deliberate and worth
 * stating rather than hiding: `app.purge_expired_items` is the only code permitted to redact
 * `app.event`, and being a SQL function it cannot delete a blob. So a document's bytes go
 * from TypeScript after its row does. Moving the purge out of that function, or leaving
 * orphaned bytes in object storage, are both worse than a step only one kind of entry needs.
 */

import type {
  Actor,
  Item,
  PersonId,
  ProjectionPort,
  RoomId,
  TrashEntry,
  TrashHandle,
  TrashPort,
  TrashRestored,
  ShortId,
} from '@photographic/core';
import { NotFoundError } from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows } from '../pool.js';
import {
  ITEM_COLUMNS,
  mapItem,
  mapTrashEntry,
  type ItemRow,
  type TrashEntryRow,
} from '../rows.js';
import { appendEvent } from './events.js';
import type { PgDocuments } from './documents.js';
import type { PgIngest } from './ingest.js';
import { accessibleRoomIds, assertCanWrite, canRead } from './permissions.js';

export const DEFAULT_PURGE_LIMIT = 500;

const TRASH_COLUMNS = `entry_type, short_id, document_id, filename, byte_size, room_id,
                       room_title, kind, body, deleted_at, deleted_by, deleted_by_client,
                       delete_reason, purge_after`;

export class PgTrash implements TrashPort {
  constructor(
    private readonly pool: Pool,
    private readonly ingest: PgIngest,
    private readonly projection: ProjectionPort,
    /**
     * The document half of the trash.
     *
     * Injected rather than reimplemented, so a document's restore and purge go through the
     * same transactional lifecycle path `PgDocuments` already uses. Two implementations of
     * "put a file back" is the drift this unification exists to remove.
     */
    private readonly documents: PgDocuments,
  ) {}

  async list(actor: Actor, input: { roomId?: RoomId; limit?: number } = {}): Promise<TrashEntry[]> {
    const scope = input.roomId
      ? (await canRead(this.pool, actor.personId, input.roomId)) ? [input.roomId] : []
      : await accessibleRoomIds(this.pool, actor.personId);
    if (scope.length === 0) return [];

    // `app.trash` is a view over the log: membership comes from the most recent lifecycle
    // event for each thing, and who deleted it, from which client and why come from that
    // event rather than from five mutable columns that recorded the same thing twice. Both
    // halves of the union are derived that way, which is what makes them one surface rather
    // than two lists rendered next to each other.
    const rows = await queryRows<TrashEntryRow>(
      this.pool,
      `SELECT ${TRASH_COLUMNS}
       FROM app.trash
       WHERE room_id = ANY($1::uuid[])
       ORDER BY deleted_at DESC
       LIMIT $2`,
      [scope, input.limit ?? 50],
    );

    const now = new Date();
    return rows.map((row) => mapTrashEntry(row, now));
  }

  async restore(actor: Actor, handle: TrashHandle, roomId?: RoomId): Promise<TrashRestored> {
    if (handle.type === 'document') {
      const document = await this.documents.restore(actor, handle.documentId);
      if (!document) throw new NotFoundError('Det finns inget att återställa.');
      return { type: 'document', document };
    }

    const item = await this.findByShortId(actor.personId, handle.shortId, roomId);
    if (!item || !(await this.isInTrash({ item_id: item.id }))) {
      throw new NotFoundError('Det finns inget att återställa.');
    }
    await assertCanWrite(this.pool, actor.personId, item.roomId);

    return { type: 'memory', item: await this.ingest.restore(actor, item) };
  }

  /**
   * Everything whose thirty days are up, both kinds.
   *
   * Memories first and then documents, in one method, because the job that calls this is
   * `purge_trash` and there is one retention promise rather than two. The two halves do not
   * share an implementation — one redacts the log through a SQL function, the other deletes
   * chunks, a row and a blob — and pretending they did would mean a generic purge that could
   * do neither properly.
   */
  async purgeExpired(limit = DEFAULT_PURGE_LIMIT): Promise<number> {
    const due = await queryRows<ItemRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS} FROM app.item
       WHERE status = 'deleted' AND purge_after IS NOT NULL AND purge_after <= now()
       ORDER BY purge_after ASC
       LIMIT $1`,
      [limit],
    );

    const items = due.map(mapItem);

    for (const item of items) {
      await appendEvent(this.pool, {
        roomId: item.roomId,
        eventType: 'item.purged',
        payload: { item_id: item.id, short_id: item.shortId },
        actorPersonId: item.deletedBy,
        agentClient: item.deletedByClient,
        motivation: 'Trettio dagar gick. Texten är permanent raderad.',
      });
    }

    if (items.length > 0) {
      // The database function is the only code permitted to redact `app.event`; it also
      // deletes the `app.item` rows in the same statement.
      await this.pool.query('SELECT app.purge_expired_items($1)', [limit]);
      await this.invalidateAfterPurge(items);
    }

    // The document-only half: chunks, row, storage charge, bytes, and its own
    // `document.purged`. `PgDocuments.purgeExpired` owns that order — the blob goes last,
    // because a blob deleted before its row would leave a document that lists and refuses to
    // download.
    const documents = await this.documents.purgeExpired(limit);

    return items.length + documents;
  }

  async purgeNow(actor: Actor, handle: TrashHandle, roomId?: RoomId): Promise<void> {
    if (handle.type === 'document') {
      // Brings the deadline forward and runs the same sweep, rather than a second
      // hard-delete path: emptying the trash early has to remove exactly what waiting thirty
      // days would have removed, including the bytes.
      //
      // Asked of the view rather than of `PgDocuments.get`, which hides the trash by design —
      // and asking the view is the same question the memory half asks, which is the point.
      if (!(await this.isInTrash({ document_id: handle.documentId }))) {
        throw new NotFoundError('Det finns inget att radera.');
      }
      const room = await queryOne<{ room_id: string }>(
        this.pool,
        `SELECT room_id FROM app.trash WHERE document_id = $1`,
        [handle.documentId],
      );
      if (!room || !(await canWrite(this.pool, actor.personId, room.room_id as RoomId))) {
        throw new NotPermittedError();
      }

      await this.pool.query(`UPDATE app.document SET purge_after = now() WHERE id = $1`, [
        handle.documentId,
      ]);
      await this.documents.purgeExpired(1);
      return;
    }

    const item = await this.findByShortId(actor.personId, handle.shortId, roomId);
    if (!item || !(await this.isInTrash({ item_id: item.id }))) {
      throw new NotFoundError('Det finns inget att radera.');
    }
    await assertCanWrite(this.pool, actor.personId, item.roomId);

    await appendEvent(this.pool, {
      roomId: item.roomId,
      eventType: 'item.purged',
      payload: { item_id: item.id, short_id: item.shortId },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      explicit: true,
      motivation: 'Permanent raderat på din begäran, före de trettio dagarna.',
    });

    await this.pool.query(`UPDATE app.item SET purge_after = now() WHERE id = $1`, [item.id]);
    await this.pool.query('SELECT app.purge_expired_items($1)', [1]);
    await this.invalidateAfterPurge([item]);
  }

  /**
   * Whether the log says this thing is in the trash right now.
   *
   * Asked of the view rather than of a status column, so a delete-undo-delete sequence has
   * exactly one answer instead of two that can disagree — for a document exactly as for a
   * memory, which is the property the union view buys.
   */
  private async isInTrash(where: { item_id?: string; document_id?: string }): Promise<boolean> {
    const row = await queryOne<{ present: boolean }>(
      this.pool,
      `SELECT EXISTS (
         SELECT 1 FROM app.trash
         WHERE ($1::uuid IS NULL OR item_id = $1::uuid)
           AND ($2::uuid IS NULL OR document_id = $2::uuid)
           AND ($1::uuid IS NOT NULL OR $2::uuid IS NOT NULL)
       ) AS present`,
      [where.item_id ?? null, where.document_id ?? null],
    );
    return row?.present ?? false;
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
