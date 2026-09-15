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
  PersonId,
  RoomId,
} from '@photographic/core';
import { NotPermittedError } from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows, type Db } from '../pool.js';
import { mapEvent, type EventRow } from '../rows.js';
import { canRead } from './permissions.js';

export async function appendEvent(
  db: Db,
  input: {
    roomId: RoomId;
    eventType: string;
    payload: Record<string, unknown>;
    actorPersonId?: PersonId | null;
    agentClient?: AgentClient | null;
    sessionRef?: string | null;
    approvedBy?: PersonId | null;
  },
): Promise<MemoryEvent> {
  const row = await queryOne<EventRow>(
    db,
    `INSERT INTO app.event (room_id, event_type, payload, actor_person_id, agent_client, session_ref, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7::uuid IS NULL THEN NULL ELSE now() END)
     RETURNING seq, id, room_id, event_type, payload, actor_person_id, agent_client, session_ref, approved_by, occurred_at`,
    [
      input.roomId,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
      input.actorPersonId ?? null,
      input.agentClient ?? null,
      input.sessionRef ?? null,
      input.approvedBy ?? null,
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
    sessionRef?: string;
    approvedBy?: PersonId;
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
      `SELECT seq, id, room_id, event_type, payload, actor_person_id, agent_client, session_ref, approved_by, occurred_at
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
      `SELECT seq, id, room_id, event_type, payload, actor_person_id, agent_client, session_ref, approved_by, occurred_at
       FROM app.event
       WHERE room_id = $1 AND seq > $2
       ORDER BY seq ASC`,
      [roomId, seq],
    );
    return rows.map(mapEvent);
  }
}
