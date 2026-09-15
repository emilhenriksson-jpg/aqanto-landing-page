/**
 * The event log, backed by `app.event`.
 *
 * `append` is used everywhere else in this package as a plain function rather than
 * through the port, so a write path that needs to append inside an already-open
 * transaction can pass the transaction client straight through instead of reaching for
 * a fresh connection.
 */

import type {
  Actor,
  AgentClient,
  EventPort,
  MemoryEvent,
  MemorySource,
  PersonId,
  RoomId,
} from '@photographic/core';
import { NotPermittedError } from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows, type Db } from '../pool.js';
import { EVENT_COLUMNS, mapEvent, type EventRow } from '../rows.js';
import { canRead } from './permissions.js';

export async function appendEvent(
  db: Db,
  input: {
    roomId: RoomId;
    eventType: string;
    payload: Record<string, unknown>;
    actorPersonId?: PersonId | null;
    agentClient?: AgentClient | null;
    clientId?: string | null;
    sessionRef?: string | null;
    approvedBy?: PersonId | null;
    motivation?: string | null;
    explicit?: boolean;
    source?: MemorySource | null;
    fromRoomId?: RoomId | null;
    toRoomId?: RoomId | null;
  },
): Promise<MemoryEvent> {
  const row = await queryOne<EventRow>(
    db,
    `INSERT INTO app.event (room_id, event_type, payload, actor_person_id, agent_client, client_id,
                            session_ref, approved_by, approved_at, motivation, explicit,
                            source_kind, source_label, source_ref, source_uri,
                            from_room_id, to_room_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             CASE WHEN $8::uuid IS NULL THEN NULL ELSE now() END,
             $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${EVENT_COLUMNS}`,
    [
      input.roomId,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
      input.actorPersonId ?? null,
      input.agentClient ?? null,
      input.clientId ?? null,
      input.sessionRef ?? null,
      input.approvedBy ?? null,
      input.motivation?.trim() || null,
      input.explicit ?? false,
      input.source?.kind ?? null,
      input.source?.label ?? null,
      input.source?.ref ?? null,
      input.source?.uri ?? null,
      input.fromRoomId ?? null,
      input.toRoomId ?? null,
    ],
  );
  return mapEvent(row!);
}

export class PgEvents implements EventPort {
  constructor(private readonly pool: Pool) {}

  async append(input: {
    roomId: RoomId;
    eventType: string;
    payload: Record<string, unknown>;
    actorPersonId?: PersonId;
    agentClient?: AgentClient;
    clientId?: string;
    sessionRef?: string;
    approvedBy?: PersonId;
    motivation?: string;
    explicit?: boolean;
    source?: MemorySource;
    fromRoomId?: RoomId;
    toRoomId?: RoomId;
  }): Promise<MemoryEvent> {
    return appendEvent(this.pool, input);
  }

  async replay(input: {
    roomId?: RoomId;
    fromSeq?: number;
    limit?: number;
  } = {}): Promise<MemoryEvent[]> {
    const rows = await queryRows<EventRow>(
      this.pool,
      `SELECT ${EVENT_COLUMNS}
       FROM app.event
       WHERE ($1::uuid IS NULL OR room_id = $1)
         AND seq > $2
       ORDER BY seq ASC
       LIMIT $3`,
      [input.roomId ?? null, input.fromSeq ?? 0, input.limit ?? 1000],
    );
    return rows.map(mapEvent);
  }

  async since(actor: Actor, roomId: RoomId, seq: number): Promise<MemoryEvent[]> {
    if (!(await canRead(this.pool, actor.personId, roomId))) throw new NotPermittedError();
    const rows = await queryRows<EventRow>(
      this.pool,
      `SELECT ${EVENT_COLUMNS}
       FROM app.event
       WHERE room_id = $1 AND seq > $2
       ORDER BY seq ASC`,
      [roomId, seq],
    );
    return rows.map(mapEvent);
  }
}
