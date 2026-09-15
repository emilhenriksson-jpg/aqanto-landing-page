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
  Item,
  ItemId,
  ItemKind,
  MemoryChange,
  MemoryChangeStep,
  MemoryEvent,
  Provenance,
  RoomId,
  ShortId,
} from '@photographic/core';

import { MemoryStore } from './store.js';

/**
 * The event types that set a value, as opposed to happening around one. Mirrors
 * `VALUE_EVENT_TYPES` in the Postgres implementation.
 *
 * `item.restored` is absent on purpose: coming back from the trash does not change what
 * a memory says, and listing it would make "hur har det ändrats" answer with an
 * administrative act.
 */
const VALUE_EVENT_TYPES = new Set([
  'item.created',
  'item.shared',
  'item.updated',
  'item.superseded',
]);

/**
 * One step per distinct value, not one per event that mentioned it.
 *
 * A correction writes two events for one transition: `item.created` for the memory that
 * replaces, and `item.superseded` for the memory being replaced. Both are true and both
 * are needed — `resolveDispute` produces only the second, because the winner already
 * existed — but rendering both makes one correction read as two. Consecutive steps that
 * arrive at the same body collapse, keeping the earlier provenance and whichever of the
 * two recorded the value it replaced.
 */
export function collapseValueSteps(steps: MemoryChangeStep[]): MemoryChangeStep[] {
  const out: MemoryChangeStep[] = [];

  for (const step of steps) {
    const previousStep = out.at(-1);

    if (previousStep && previousStep.body !== null && previousStep.body === step.body) {
      out[out.length - 1] = {
        ...previousStep,
        previousBody: previousStep.previousBody ?? step.previousBody,
        shortId: previousStep.shortId ?? step.shortId,
      };
      continue;
    }

    out.push(step);
  }

  return out;
}

/**
 * Event types a person should see, and what to call them.
 *
 * An allowlist rather than a formatter with a default branch: job bookkeeping and
 * projection rebuilds are noise, and a feed that shows them buries the two lines that
 * actually matter. Anything not listed here is invisible, which is the safe direction —
 * a new internal event type cannot leak into the feed by being forgotten about.
 */
export const ACTION_OF: Record<string, HistoryAction> = {
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
  // Kept identical to `PgHistory`'s copy on purpose: a person must see the same feed
  // whichever implementation is serving them, and an emergency sign-in is the last thing
  // that should be visible in one and invisible in the other.
  'session.break_glass_minted': 'break_glass_minted',
  'session.break_glass_used': 'break_glass_used',
};

export const DEFAULT_HISTORY_LIMIT = 100;

const ITEM_KINDS = new Set<string>([
  'identity',
  'fact',
  'preference',
  'instruction',
  'decision',
  'note',
  'never',
  'compass',
]);

function isItemKind(value: unknown): value is ItemKind {
  return typeof value === 'string' && ITEM_KINDS.has(value);
}

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

    const events = this.store.eventsForItem(item.id);
    const created = events.find(
      (e) => e.eventType === 'item.created' || e.eventType === 'item.shared',
    );

    return {
      shortId: item.shortId,
      body: item.body,
      roomTitle: this.store.rooms.get(item.roomId)?.title ?? '',
      savedAt: item.createdAt,
      savedByClient: created?.agentClient ?? null,
      approvedByName: created?.approvedBy
        ? this.store.persons.get(created.approvedBy)?.displayName ?? null
        : null,
      // The two questions section 4 of the scope asks that the timeline alone cannot
      // answer: why it was stored where it is, and where the information came from.
      motivation: created?.motivation ?? null,
      source: created?.source ?? null,
      changed: events.some(
        (e) => e.eventType === 'item.updated' || e.eventType === 'item.superseded',
      ),
      timeline,
      // Null, and honestly so. This implementation computes its vectors in-process from
      // whatever `LlmPort` it was handed, and the write path that would record a model's
      // identity lives in `MemoryIngest` — which the Postgres path records at the point
      // the vector is written (`embed_item` and the backfill). A reference
      // implementation that is only ever wired to `FakeLlm` has nothing to disclose,
      // because nothing leaves the process; wiring a real provider into it would need
      // this filled in, and it is stated rather than quietly returning a value.
      embedding: null,
    };
  }

  /**
   * Every value a memory has held, across the supersede chain. See `HistoryPort.changes`
   * for the contract and `PgHistory.changes` for the SQL that mirrors this.
   *
   * The walk is the same shape: forward along `supersededBy` from each supplied short id
   * to the head of its chain, so any id in a chain resolves to the same chain, then back
   * from the head over everything that was replaced by something in it.
   *
   * The head must be `active` and readable. That is the safety property: the steps carry
   * text the person has replaced, and handing them back for a memory now in the trash
   * would resurface a body the deletion was supposed to remove from view.
   */
  async changes(
    actor: Actor,
    shortIds: ShortId[],
    input: { limit?: number } = {},
  ): Promise<MemoryChange[]> {
    const heads = new Map<ItemId, Item>();

    for (const shortId of shortIds) {
      // `findByShortId` resolves permission itself, and it finds superseded items too —
      // which is required, because the id a person remembers may be the old one.
      const seed = this.store.findByShortId(actor.personId, shortId);
      if (!seed) continue;

      const head = this.headOf(seed);
      // Only a memory that exists right now has a chain to show.
      if (head.status !== 'active') continue;
      if (!this.store.canRead(actor.personId, head.roomId)) continue;

      heads.set(head.id, head);
    }

    const chains: MemoryChange[] = [];

    for (const head of heads.values()) {
      const members = this.chainOf(head);

      const steps = collapseValueSteps(
        members
          .flatMap((item) => this.store.eventsForItem(item.id))
          .filter((event) => VALUE_EVENT_TYPES.has(event.eventType))
          .sort((a, b) => a.seq - b.seq)
          .map((event) => this.toChangeStep(event)),
      );
      if (steps.length === 0) continue;

      chains.push({
        shortId: head.shortId,
        roomId: head.roomId,
        roomTitle: this.store.rooms.get(head.roomId)?.title ?? '',
        currentBody: head.body,
        itemKind: head.kind,
        steps,
        firstSavedAt: steps[0]!.at,
        lastChangedAt: steps.at(-1)!.at,
        changeCount: steps.length - 1,
      });
    }

    return chains
      .sort((a, b) => b.lastChangedAt.getTime() - a.lastChangedAt.getTime())
      .slice(0, input.limit ?? 25);
  }

  /**
   * Follows `supersededBy` to the end of the chain.
   *
   * Bounded by the number of items rather than by trust: `supersededBy` is written by the
   * application and a cycle is a bug, not an impossibility, and a read path that can hang
   * on one is worse than a read path that gives up.
   */
  private headOf(item: Item): Item {
    const seen = new Set<ItemId>([item.id]);
    let current = item;

    while (current.supersededBy) {
      const next = this.store.items.get(current.supersededBy);
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      current = next;
    }

    return current;
  }

  /** The head and everything that was ever replaced by something in the chain. */
  private chainOf(head: Item): Item[] {
    const members = [head];
    const seen = new Set<ItemId>([head.id]);

    for (let i = 0; i < members.length; i += 1) {
      const current = members[i]!;
      for (const candidate of this.store.items.values()) {
        if (candidate.supersededBy === current.id && !seen.has(candidate.id)) {
          seen.add(candidate.id);
          members.push(candidate);
        }
      }
    }

    return members;
  }

  private toChangeStep(event: MemoryEvent): MemoryChangeStep {
    const redacted = event.payload['redacted'] === true;
    const body = typeof event.payload['body'] === 'string' ? event.payload['body'] : null;
    const previous =
      typeof event.payload['previous'] === 'string' ? event.payload['previous'] : null;
    const shortId =
      typeof event.payload['short_id'] === 'string'
        ? (event.payload['short_id'] as ShortId)
        : null;

    return {
      seq: event.seq,
      at: event.occurredAt,
      body: redacted ? null : body,
      previousBody: redacted ? null : previous,
      shortId,
      action: ACTION_OF[event.eventType] ?? 'updated',
      agentClient: event.agentClient,
      actorName: event.actorPersonId
        ? this.store.persons.get(event.actorPersonId)?.displayName ?? null
        : null,
      source: event.source,
      motivation: event.motivation,
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
      // Present on `item.created` and `item.shared` only; see `HistoryEntry.itemKind`.
      itemKind: isItemKind(event.payload['kind']) ? event.payload['kind'] : null,
      agentClient: event.agentClient,
      actorName: event.actorPersonId
        ? this.store.persons.get(event.actorPersonId)?.displayName ?? null
        : null,
      wasApproved: event.approvedBy !== null,
      redacted,
    };
  }
}
