/**
 * History, and the answer to "how do you know that about me?". Backed by `app.event`;
 * see `MemoryHistory` for the allowlist reasoning.
 */

import type { Actor, HistoryAction, HistoryEntry, HistoryPort, MemoryEvent, Provenance, RoomId, ShortId } from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows } from '../pool.js';
import { mapEvent, mapItem, type EventRow, type ItemRow } from '../rows.js';
import { accessibleRoomIds, canRead } from './permissions.js';

const ACTION_OF: Record<string, HistoryAction> = {
  'item.created': 'saved',
  'item.updated': 'updated',
  'item.superseded': 'superseded',
  'item.deleted': 'deleted',
  'item.restored': 'restored',
  'item.purged': 'purged',
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
      `SELECT e.seq, e.id, e.room_id, e.event_type, e.payload, e.actor_person_id, e.agent_client,
              e.session_ref, e.approved_by, e.occurred_at, r.title AS room_title, p.display_name AS actor_name
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
    const scope = roomId ? [roomId] : await accessibleRoomIds(this.pool, actor.personId);
    if (scope.length === 0) return null;

    const itemRow = await queryOne<ItemRow>(
      this.pool,
      `SELECT id, short_id, room_id, kind, body, structured, sensitivity, status, valid_from,
              valid_to, superseded_by, salience, token_estimate, last_used_at, use_count,
              created_at, deleted_at, deleted_by, deleted_by_client, purge_after, delete_reason
       FROM app.item WHERE short_id = $1 AND room_id = ANY($2::uuid[])`,
      [shortId, scope],
    );
    if (!itemRow) return null;
    const item = mapItem(itemRow);
    if (!(await canRead(this.pool, actor.personId, item.roomId))) return null;

    const roomTitle = await queryOne<{ title: string }>(this.pool, `SELECT title FROM app.room WHERE id = $1`, [
      item.roomId,
    ]);

    const eventRows = await queryRows<EventRow & { room_title: string; actor_name: string | null }>(
      this.pool,
      `SELECT e.seq, e.id, e.room_id, e.event_type, e.payload, e.actor_person_id, e.agent_client,
              e.session_ref, e.approved_by, e.occurred_at, r.title AS room_title, p.display_name AS actor_name
       FROM app.event e
       JOIN app.room r ON r.id = e.room_id
       LEFT JOIN app.person p ON p.id = e.actor_person_id
       WHERE e.event_type = ANY($1::text[]) AND (e.payload ->> 'item_id') = $2
       ORDER BY e.seq ASC`,
      [Object.keys(ACTION_OF), item.id],
    );

    const timeline = eventRows.map((row) => toEntry(row));
    const created = eventRows.find((r) => r.event_type === 'item.created');

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
