/**
 * History, and the answer to "how do you know that about me?". Backed by `app.event`;
 * see `MemoryHistory` for the allowlist reasoning.
 */

import type { Actor, HistoryAction, HistoryEntry, HistoryPort, MemoryEvent, Provenance, RoomId, ShortId } from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows } from '../pool.js';
import {
  EVENT_COLUMNS_PREFIXED,
  ITEM_COLUMNS,
  mapEvent,
  mapItem,
  mapSource,
  type EventRow,
  type ItemRow,
} from '../rows.js';
import { accessibleRoomIds, canRead } from './permissions.js';

const ACTION_OF: Record<string, HistoryAction> = {
  'item.created': 'saved',
  'item.updated': 'updated',
  'item.superseded': 'superseded',
  'item.shared': 'shared',
  'item.moved': 'moved',
  'item.deleted': 'deleted',
  'item.restored': 'restored',
  'item.purged': 'purged',
  'item.disputed': 'disputed',
  'item.dispute_resolved': 'dispute_resolved',
  'proposal.created': 'proposed',
  'proposal.accepted': 'approved',
  'proposal.rejected': 'rejected',
  'document.uploaded': 'document_added',
  'room.created': 'room_created',
  'member.joined': 'member_joined',
  'member.left': 'member_left',
};

export const DEFAULT_HISTORY_LIMIT = 100;

export class PgHistory implements HistoryPort {
  constructor(private readonly pool: Pool) {}

  async list(
    actor: Actor,
    input: { roomId?: RoomId; since?: Date; limit?: number } = {},
  ): Promise<HistoryEntry[]> {
    const scope = input.roomId
      ? (await canRead(this.pool, actor.personId, input.roomId)) ? [input.roomId] : []
      : await accessibleRoomIds(this.pool, actor.personId);
    if (scope.length === 0) return [];

    const rows = await queryRows<EventRow & { room_title: string; actor_name: string | null }>(
      this.pool,
      `SELECT ${EVENT_COLUMNS_PREFIXED}, r.title AS room_title, p.display_name AS actor_name
       FROM app.event e
       JOIN app.room r ON r.id = e.room_id
       LEFT JOIN app.person p ON p.id = e.actor_person_id
       WHERE e.room_id = ANY($1::uuid[])
         AND e.event_type = ANY($2::text[])
         AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
       ORDER BY e.seq DESC
       LIMIT $4`,
      [scope, Object.keys(ACTION_OF), input.since ?? null, input.limit ?? DEFAULT_HISTORY_LIMIT],
    );

    return rows.map((row) => toEntry(row));
  }

  async provenance(actor: Actor, shortId: ShortId, roomId?: RoomId): Promise<Provenance | null> {
    // Two different sets. `readable` is every room this person may see and bounds the
    // history; `lookup` is where the caller says the memory is, and only disambiguates
    // a short id. Narrowing the history to `lookup` too would drop the event a move
    // wrote in the room the memory came *from*, which is the half of "it used to live
    // somewhere else" that matters.
    const readable = await accessibleRoomIds(this.pool, actor.personId);
    const lookup = roomId ? readable.filter((id) => id === roomId) : readable;
    if (lookup.length === 0) return null;

    const itemRow = await queryOne<ItemRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS} FROM app.item WHERE short_id = $1 AND room_id = ANY($2::uuid[])`,
      [shortId, lookup],
    );
    if (!itemRow) return null;
    const item = mapItem(itemRow);
    if (!(await canRead(this.pool, actor.personId, item.roomId))) return null;

    const roomTitle = await queryOne<{ title: string }>(this.pool, `SELECT title FROM app.room WHERE id = $1`, [
      item.roomId,
    ]);

    // Two conditions that look like belt-and-braces and are not.
    //
    // `room_id = ANY(readable)` is the permission filter every read owes. Without it the
    // query trusted that an event mentioning this item is an event about a room this
    // person may see, and a move writes one in a room they may have left.
    //
    // `payload @> ...` rather than `payload ->> 'item_id' = ...` because the only index
    // on this column is `event_payload_idx`, a `jsonb_path_ops` GIN index, and it can
    // only answer containment. The `->>` form ignored it and scanned every event on the
    // platform — bearable when the only caller was a page nobody could reach, and not
    // once there is a link on every memory row.
    const eventRows = await queryRows<EventRow & { room_title: string; actor_name: string | null }>(
      this.pool,
      `SELECT ${EVENT_COLUMNS_PREFIXED}, r.title AS room_title, p.display_name AS actor_name
       FROM app.event e
       JOIN app.room r ON r.id = e.room_id
       LEFT JOIN app.person p ON p.id = e.actor_person_id
       WHERE e.event_type = ANY($1::text[])
         AND e.payload @> jsonb_build_object('item_id', $2::text)
         AND e.room_id = ANY($3::uuid[])
       ORDER BY e.seq ASC`,
      [Object.keys(ACTION_OF), item.id, readable],
    );

    const timeline = eventRows.map((row) => toEntry(row));
    const created = eventRows.find(
      (r) => r.event_type === 'item.created' || r.event_type === 'item.shared',
    );

    let approvedByName: string | null = null;
    if (created?.approved_by) {
      const approver = await queryOne<{ display_name: string | null }>(
        this.pool,
        `SELECT display_name FROM app.person WHERE id = $1`,
        [created.approved_by],
      );
      approvedByName = approver?.display_name ?? null;
    }

    return {
      shortId: item.shortId,
      body: item.body,
      roomTitle: roomTitle?.title ?? '',
      savedAt: item.createdAt,
      savedByClient: created?.agent_client ?? null,
      approvedByName,
      // The two questions section 4 asks that a timeline alone cannot answer: why it was
      // stored where it is, and where the information came from.
      motivation: created?.motivation ?? null,
      source: created ? mapSource(created) : null,
      changed: eventRows.some(
        (r) => r.event_type === 'item.updated' || r.event_type === 'item.superseded',
      ),
      timeline,
    };
  }
}

function toEntry(row: EventRow & { room_title: string; actor_name: string | null }): HistoryEntry {
  const event = mapEvent(row);
  const redacted = event.payload['redacted'] === true;
  const body = typeof event.payload['body'] === 'string' ? event.payload['body'] : null;
  const shortId = typeof event.payload['short_id'] === 'string' ? (event.payload['short_id'] as ShortId) : null;

  return {
    seq: event.seq,
    action: ACTION_OF[event.eventType]!,
    occurredAt: event.occurredAt,
    roomId: event.roomId,
    roomTitle: row.room_title,
    shortId,
    body: redacted ? null : body,
    agentClient: event.agentClient,
    actorName: row.actor_name,
    wasApproved: event.approvedBy !== null,
    redacted,
  };
}
