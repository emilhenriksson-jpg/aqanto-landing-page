/**
 * Sessions, and the honest answer to "is this actually working?".
 *
 * We cannot force every AI client to read the personal room. Some drop the MCP
 * `instructions` string, some only read it on the first connection, some will change
 * behaviour in a release we find out about from a support message. Promising that it
 * always works would be a promise we do not control.
 *
 * So instead we measure it. Every delivery is recorded with the route it took, and the
 * person sees a light per client. Transparency is the only honest promise available
 * here, and it turns an invisible failure into a visible one with a fix next to it.
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

import { MemoryStore, newId } from './store.js';

export class MemorySessions implements SessionPort {
  /**
   * Mirrors `client_session.last_seen_at`, which the domain type does not surface.
   *
   * Verification compares it against a baseline taken when the person pressed connect,
   * so that reconnecting a client that worked last week does not light up green
   * instantly. That makes it load-bearing rather than telemetry.
   */
  private readonly lastSeen = new Map<SessionId, Date>();

  constructor(private readonly store: MemoryStore) {}

  async start(input: {
    personId: PersonId;
    agentClient: AgentClient;
    transport: Transport;
  }): Promise<ClientSession> {
    const session: ClientSession = {
      id: newId<SessionId>(),
      personId: input.personId,
      agentClient: input.agentClient,
      transport: input.transport,
      startedAt: this.store.now(),
      profileDelivered: false,
      profileVersion: null,
      deliveryMethod: null,
    };

    this.store.sessions.set(session.id, session);
    this.lastSeen.set(session.id, session.startedAt);
    return session;
  }

  async recordDelivery(
    sessionId: SessionId,
    method: DeliveryMethod,
    profileVersion: number,
  ): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session) throw new NotFoundError('Sessionen finns inte.');

    session.profileDelivered = true;
    session.deliveryMethod = method;
    session.profileVersion = profileVersion;
    this.lastSeen.set(sessionId, this.store.now());
  }

  /**
   * One row per client, from its most recent session.
   *
   * Per client rather than per session because that is the unit the person thinks in:
   * "does Claude know about me" is the question, not "did session 4f2a succeed".
   */
  async health(actor: Actor): Promise<
    Array<{
      agentClient: AgentClient;
      lastSeenAt: Date;
      profileDelivered: boolean;
      deliveryMethod: DeliveryMethod | null;
    }>
  > {
    const latest = new Map<AgentClient, { session: ClientSession; seenAt: Date }>();

    for (const session of this.store.sessions.values()) {
      if (session.personId !== actor.personId) continue;
      const seenAt = this.lastSeen.get(session.id) ?? session.startedAt;
      const current = latest.get(session.agentClient);
      if (!current || seenAt > current.seenAt) {
        latest.set(session.agentClient, { session, seenAt });
      }
    }

    return [...latest.values()]
      .sort((a, b) => b.seenAt.getTime() - a.seenAt.getTime())
      .map(({ session, seenAt }) => ({
        agentClient: session.agentClient,
        lastSeenAt: seenAt,
        profileDelivered: session.profileDelivered,
        deliveryMethod: session.deliveryMethod,
      }));
  }
}
