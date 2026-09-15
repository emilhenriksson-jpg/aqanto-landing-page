/**
 * Sessions, backed by `app.client_session`. See `MemorySessions` for why this exists:
 * we cannot force a client to read the profile, so we measure whether it did.
 */

import type {
  Actor,
  AgentClient,
  ClientSession,
  DeliveryMethod,
  PersonId,
  SessionId,
  SessionPort,
  Transport,
} from '@photographic/core';
import { NotFoundError } from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows } from '../pool.js';
import { mapSession, type ClientSessionRow } from '../rows.js';

export class PgSessions implements SessionPort {
  constructor(private readonly pool: Pool) {}

  async start(input: {
    personId: PersonId;
    agentClient: AgentClient;
    transport: Transport;
  }): Promise<ClientSession> {
    const row = await queryOne<ClientSessionRow>(
      this.pool,
      `INSERT INTO app.client_session (person_id, agent_client, transport)
       VALUES ($1, $2, $3)
       RETURNING id, person_id, agent_client, transport, started_at, profile_delivered, profile_version, delivery_method`,
      [input.personId, input.agentClient, input.transport],
    );
    return mapSession(row!);
  }

  async recordDelivery(sessionId: SessionId, method: DeliveryMethod, profileVersion: number): Promise<void> {
    const result = await this.pool.query(
      `UPDATE app.client_session
       SET profile_delivered = true, delivery_method = $2, profile_version = $3, last_activity_at = now()
       WHERE id = $1`,
      [sessionId, method, profileVersion],
    );
    if (result.rowCount === 0) throw new NotFoundError('Sessionen finns inte.');
  }

  async health(actor: Actor): Promise<
    Array<{
      agentClient: AgentClient;
      lastSeenAt: Date;
      profileDelivered: boolean;
      deliveryMethod: DeliveryMethod | null;
    }>
  > {
    // One row per client, from its most recent session -- `DISTINCT ON` ordered by
    // recency is the SQL shape of the "latest wins" rule `MemorySessions` implements
    // with a map.
    const rows = await queryRows<ClientSessionRow & { last_seen: Date }>(
      this.pool,
      `SELECT DISTINCT ON (agent_client) id, person_id, agent_client, transport, started_at,
              profile_delivered, profile_version, delivery_method, last_activity_at AS last_seen
       FROM app.client_session
       WHERE person_id = $1
       ORDER BY agent_client, last_activity_at DESC`,
      [actor.personId],
    );

    return rows
      .map((row) => ({
        agentClient: row.agent_client,
        lastSeenAt: row.last_seen,
        profileDelivered: row.profile_delivered,
        deliveryMethod: row.delivery_method,
      }))
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  }
}
