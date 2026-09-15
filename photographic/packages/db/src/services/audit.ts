/**
 * The access log, backed by `app.access_log`. Separate from `app.event`, and for the
 * same reason `services-memory` keeps them apart: this is who looked, not what
 * happened to someone's memory, and the two have different audiences.
 */

import type { Actor, AuditPort, ItemId, RoomId } from '@photographic/core';
import type { Pool } from 'pg';

export class PgAudit implements AuditPort {
  constructor(private readonly pool: Pool) {}

  async record(input: {
    actor: Actor;
    roomId?: RoomId;
    action: 'read' | 'search' | 'write' | 'delete' | 'bundle';
    itemIds?: ItemId[];
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO app.access_log (person_id, room_id, agent_client, action, item_ids, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.actor.personId,
        input.roomId ?? null,
        input.actor.agentClient,
        input.action,
        input.itemIds ?? [],
        JSON.stringify(input.detail ?? {}),
      ],
    );
  }
}
