/**
 * The event log, exposed.
 *
 * `replay` takes no actor on purpose: it is how projections get rebuilt when their
 * format changes, and a rebuild is not something a person does. `since` is the
 * request-facing one and takes an actor, because it answers "what changed in this room"
 * for a specific person.
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

import { MemoryStore } from './store.js';

export class MemoryEvents implements EventPort {
  constructor(private readonly store: MemoryStore) {}

  async append(input: {
    roomId: RoomId;
    eventType: string;
    payload: Record<string, unknown>;
    actorPersonId?: PersonId;
    agentClient?: AgentClient;
    sessionRef?: string;
    approvedBy?: PersonId;
  }): Promise<MemoryEvent> {
    return this.store.append(input);
  }

  async replay(input: {
    roomId?: RoomId;
    fromSeq?: number;
    limit?: number;
  } = {}): Promise<MemoryEvent[]> {
    return this.store
      .allEvents()
      .filter((e) => (input.roomId ? e.roomId === input.roomId : true))
      .filter((e) => e.seq > (input.fromSeq ?? 0))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, input.limit ?? 1000);
  }

  async since(actor: Actor, roomId: RoomId, seq: number): Promise<MemoryEvent[]> {
    if (!this.store.canRead(actor.personId, roomId)) throw new NotPermittedError();
    return this.store
      .allEvents()
      .filter((e) => e.roomId === roomId && e.seq > seq)
      .sort((a, b) => a.seq - b.seq);
  }
}
