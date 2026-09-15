/**
 * History, and the answer to "how do you know that about me?".
 *
 * Saving silently is what makes the product feel effortless. It is also what would make
 * it feel uncontrollable, if nothing recorded it. This is the other half of that
 * bargain: everything a model did without asking is here, attributed to the client that
 * did it and reversible from the same screen.
 *
 * The usual complaint about AI memory is not that it forgets. It is that it knows
 * something about you and cannot say where that came from. `provenance` is the answer,
 * and it is a tool a model can call, so the question can be asked in the conversation
 * where it occurs rather than in a settings page.
 */

import type {
  Actor,
  HistoryAction,
  HistoryEntry,
  HistoryPort,
  MemoryEvent,
  Provenance,
  RoomId,
  ShortId,
} from '@photographic/core';

import { MemoryStore } from './store.js';

/**
 * Event types a person should see, and what to call them.
 *
 * An allowlist rather than a formatter with a default branch: job bookkeeping and
 * projection rebuilds are noise, and a feed that shows them buries the two lines that
 * actually matter. Anything not listed here is invisible, which is the safe direction —
 * a new internal event type cannot leak into the feed by being forgotten about.
 */
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

export class MemoryHistory implements HistoryPort {
  constructor(private readonly store: MemoryStore) {}

  async list(
    actor: Actor,
    input: { roomId?: RoomId; since?: Date; limit?: number } = {},
  ): Promise<HistoryEntry[]> {
    const scope = new Set(
      input.roomId
        ? this.store.canRead(actor.personId, input.roomId)
          ? [input.roomId]
          : []
        : this.store.accessibleRoomIds(actor.personId),
    );

    return this.store
      .allEvents()
      .filter((e) => scope.has(e.roomId) && ACTION_OF[e.eventType] !== undefined)
      .filter((e) => (input.since ? e.occurredAt >= input.since : true))
      // Newest first: this is a feed someone opens to see what just happened, not an
      // archive they read forwards.
      .sort((a, b) => b.seq - a.seq)
      .slice(0, input.limit ?? DEFAULT_HISTORY_LIMIT)
      .map((e) => this.toEntry(e));
  }

  async provenance(actor: Actor, shortId: ShortId, roomId?: RoomId): Promise<Provenance | null> {
    const item = this.store.findByShortId(actor.personId, shortId, roomId);
    if (!item) return null;
    if (!this.store.canRead(actor.personId, item.roomId)) return null;

    // Oldest first here, unlike the feed: this is the story of one memory, and a story
    // told backwards does not answer "where did this come from".
    const timeline = this.store
      .eventsForItem(item.id)
      .filter((e) => ACTION_OF[e.eventType] !== undefined)
      .sort((a, b) => a.seq - b.seq)
      .map((e) => this.toEntry(e));

    const created = this.store
      .eventsForItem(item.id)
      .find((e) => e.eventType === 'item.created');

    return {
      shortId: item.shortId,
      body: item.body,
      roomTitle: this.store.rooms.get(item.roomId)?.title ?? '',
      savedAt: item.createdAt,
      savedByClient: created?.agentClient ?? null,
      approvedByName: created?.approvedBy
        ? this.store.persons.get(created.approvedBy)?.displayName ?? null
        : null,
      timeline,
    };
  }

  private toEntry(event: MemoryEvent): HistoryEntry {
    const redacted = event.payload['redacted'] === true;
    const body = typeof event.payload['body'] === 'string' ? event.payload['body'] : null;
    const shortId =
      typeof event.payload['short_id'] === 'string'
        ? (event.payload['short_id'] as ShortId)
        : null;

    return {
      seq: event.seq,
      action: ACTION_OF[event.eventType]!,
      occurredAt: event.occurredAt,
      roomId: event.roomId,
      roomTitle: this.store.rooms.get(event.roomId)?.title ?? '',
      shortId,
      // Null once purged. The entry survives so the feed can still show that something
      // was removed; the text does not, because that is what the trash promised.
      body: redacted ? null : body,
      agentClient: event.agentClient,
      actorName: event.actorPersonId
        ? this.store.persons.get(event.actorPersonId)?.displayName ?? null
        : null,
      wasApproved: event.approvedBy !== null,
      redacted,
    };
  }
}
