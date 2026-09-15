/**
 * The calendar, read out of the log.
 *
 * Nothing in this file stores anything. Every method is a query over the events the
 * write path already appended, which is what makes the calendar unable to disagree with
 * the history, the trash or the room — and what makes "the event log is the truth" a
 * property rather than an intention.
 *
 * The question it answers is not one the rest of the product answers. Rooms say what
 * Photographic knows; the calendar says what Photographic *did with what you told it*,
 * and that is a question about a day.
 *
 * Days only, deliberately. Week, month and year summaries are derivable from this same
 * log whenever they are wanted, and building them first would have meant shipping four
 * screens of averages over one screen of facts.
 */

import type {
  Actor,
  AgentClient,
  CalendarDay,
  CalendarEntry,
  CalendarPort,
  EventSeq,
  ItemId,
  ItemKind,
  MemoryEvent,
  MemoryEventDetail,
  MemoryEventKind,
  MemoryRevision,
  MemorySource,
  MemorySourceDetail,
  RoomId,
  SharedWith,
  ShortId,
} from '@photographic/core';
import {
  DEFAULT_TIME_ZONE,
  MEMORY_EVENT_KINDS,
  calendarDateOf,
  calendarDayRange,
  daysRemaining,
  deriveSource,
  memoryEventKindOf,
} from '@photographic/core';

import { MemoryStore } from './store.js';

export class MemoryCalendar implements CalendarPort {
  constructor(private readonly store: MemoryStore) {}

  async day(
    actor: Actor,
    input: { date: string; timeZone?: string; roomId?: RoomId },
  ): Promise<CalendarDay> {
    const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
    const scope = this.scopeFor(actor, input.roomId);
    const { from, to } = calendarDayRange(input.date, timeZone);

    const inScope = this.store
      .allEvents()
      .filter((event) => scope.has(event.roomId) && this.kindOf(event) !== null);

    const entries = inScope
      .filter((event) => event.occurredAt >= from && event.occurredAt < to)
      // Ascending: a day is read forwards, unlike the history feed, which is a list of
      // what just happened.
      .sort((a, b) => a.seq - b.seq)
      .map((event) => this.toEntry(actor, event));

    const counts = Object.fromEntries(
      MEMORY_EVENT_KINDS.map((kind) => [kind, 0]),
    ) as Record<MemoryEventKind, number>;
    for (const entry of entries) counts[entry.kind] += 1;

    const room = input.roomId ? this.store.rooms.get(input.roomId) : undefined;

    return {
      date: input.date,
      timeZone,
      roomId: input.roomId ?? null,
      roomTitle: room?.title ?? null,
      entries,
      counts,
      byOthersCount: entries.filter((entry) => entry.byOtherMember).length,
      ...this.neighbours(inScope, from, to, timeZone),
    };
  }

  async event(actor: Actor, seq: EventSeq): Promise<MemoryEventDetail | null> {
    const event = this.store.allEvents().find((e) => e.seq === Number(seq));
    if (!event) return null;
    if (!this.store.canRead(actor.personId, event.roomId)) return null;
    if (this.kindOf(event) === null) return null;

    const itemId = event.payload['item_id'] as ItemId | undefined;
    const item = itemId ? this.store.items.get(itemId) : undefined;

    const related = itemId
      ? this.store
          .eventsForItem(itemId)
          .filter((e) => this.kindOf(e) !== null)
          .sort((a, b) => a.seq - b.seq)
      : [event];

    return {
      entry: this.toEntry(actor, event),
      timeline: related.map((e) => this.toEntry(actor, e)),
      revisions: revisionsOf(related),
      source: this.sourceDetail(actor, event),
      currentBody: item?.body ?? null,
      trash:
        item && item.purgeAfter && this.store.isInTrash(item.id)
          ? {
              purgeAfter: item.purgeAfter,
              daysRemaining: daysRemaining(item.purgeAfter, this.store.now()),
            }
          : null,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private scopeFor(actor: Actor, roomId?: RoomId): Set<RoomId> {
    if (roomId) {
      return new Set(this.store.canRead(actor.personId, roomId) ? [roomId] : []);
    }
    return new Set(this.store.accessibleRoomIds(actor.personId));
  }

  private kindOf(event: MemoryEvent): MemoryEventKind | null {
    const room = this.store.rooms.get(event.roomId);
    if (!room) return null;
    return memoryEventKindOf(event.eventType, room.kind, event.payload);
  }

  private toEntry(actor: Actor, event: MemoryEvent): CalendarEntry {
    const room = this.store.rooms.get(event.roomId)!;
    const redacted = event.payload['redacted'] === true;
    const itemId = event.payload['item_id'] as ItemId | undefined;
    const item = itemId ? this.store.items.get(itemId) : undefined;

    const text = (key: string): string | null => {
      if (redacted) return null;
      const value = event.payload[key];
      return typeof value === 'string' ? value : null;
    };

    return {
      seq: event.seq,
      kind: this.kindOf(event)!,
      occurredAt: event.occurredAt,
      body: text('body'),
      previousBody: text('previous'),
      shortId: (text('short_id') as ShortId | null) ?? item?.shortId ?? null,
      itemKind: (text('kind') as ItemKind | null) ?? item?.kind ?? null,
      fromRoomTitle: event.fromRoomId
        ? this.store.rooms.get(event.fromRoomId)?.title ?? null
        : null,
      toRoomTitle: event.toRoomId ? this.store.rooms.get(event.toRoomId)?.title ?? null : null,
      sharedWith: (event.payload['shared_with'] as SharedWith[] | undefined) ?? null,
      disputes: disputesOf(event, redacted),
      provenance: {
        learnedAt: event.occurredAt,
        agentClient: event.agentClient,
        actorName: event.actorPersonId
          ? this.store.persons.get(event.actorPersonId)?.displayName ?? null
          : null,
        source: event.source ?? fallbackSource(event),
        roomId: room.id,
        roomTitle: room.title,
        roomKind: room.kind,
        motivation: event.motivation,
        explicit: event.explicit,
        wasApproved: event.approvedBy !== null,
        changed: itemId ? this.changedAfter(itemId, event.seq) : false,
      },
      // Somebody else did this, in a room shared with them. Nothing gates incoming
      // material from the other members, so noticing it is the whole defence.
      byOtherMember:
        room.kind === 'shared' &&
        event.actorPersonId !== null &&
        event.actorPersonId !== actor.personId,
      redacted,
    };
  }

  /** Whether the memory was corrected after this event — the sixth provenance question. */
  private changedAfter(itemId: ItemId, seq: EventSeq): boolean {
    return this.store
      .eventsForItem(itemId)
      .some(
        (e) =>
          e.seq > seq && (e.eventType === 'item.updated' || e.eventType === 'item.superseded'),
      );
  }

  /**
   * The last step of the zoom: day -> memory event -> source.
   *
   * `alsoFromHere` is what makes it a place rather than a label. One Claude session that
   * wrote four things reads as one conversation, which is how the person remembers it —
   * and it is the difference between "Claude saved this" and being able to see the
   * afternoon it came out of.
   */
  private sourceDetail(actor: Actor, event: MemoryEvent): MemorySourceDetail | null {
    const source = event.source ?? fallbackSource(event);
    if (!source) return null;

    const scope = new Set(this.store.accessibleRoomIds(actor.personId));
    const session = event.sessionRef
      ? this.store.sessions.get(event.sessionRef as never)
      : undefined;

    const alsoFromHere = source.ref
      ? this.store
          .allEvents()
          .filter(
            (e) =>
              e.seq !== event.seq &&
              scope.has(e.roomId) &&
              (e.source?.ref ?? fallbackSource(e)?.ref) === source.ref &&
              this.kindOf(e) !== null,
          )
          .sort((a, b) => a.seq - b.seq)
          .slice(0, 20)
          .map((e) => ({
            seq: e.seq,
            shortId: (e.payload['short_id'] as ShortId | undefined) ?? null,
            body: e.payload['redacted'] === true ? null : (e.payload['body'] as string | null) ?? null,
          }))
      : [];

    return {
      ...source,
      at: session?.startedAt ?? null,
      agentClient: event.agentClient,
      transport: session?.transport ?? null,
      alsoFromHere,
    };
  }

  /**
   * The nearest day on either side that has anything in it.
   *
   * Stepping one day at a time through an empty week is how a calendar gets abandoned, so
   * the arrows point at days that exist rather than at tomorrow.
   */
  private neighbours(
    events: MemoryEvent[],
    from: Date,
    to: Date,
    timeZone: string,
  ): { previousDate: string | null; nextDate: string | null } {
    let previous: Date | null = null;
    let next: Date | null = null;

    for (const event of events) {
      if (event.occurredAt < from) {
        if (!previous || event.occurredAt > previous) previous = event.occurredAt;
      } else if (event.occurredAt >= to) {
        if (!next || event.occurredAt < next) next = event.occurredAt;
      }
    }

    return {
      previousDate: previous ? calendarDateOf(previous, timeZone) : null,
      nextDate: next ? calendarDateOf(next, timeZone) : null,
    };
  }
}

/**
 * Every value a memory has held, oldest first.
 *
 * The first entry is the original and each later one carries what it replaced, which is
 * the scope's promise in its simplest form: the current memory says 1 november, and the
 * history says how we got there from 15 oktober.
 */
export function revisionsOf(events: MemoryEvent[]): MemoryRevision[] {
  const revisions: MemoryRevision[] = [];

  for (const event of events) {
    const redacted = event.payload['redacted'] === true;
    const body = typeof event.payload['body'] === 'string' ? event.payload['body'] : null;
    const previous = typeof event.payload['previous'] === 'string' ? event.payload['previous'] : null;

    const isValueEvent =
      event.eventType === 'item.created' ||
      event.eventType === 'item.shared' ||
      event.eventType === 'item.updated' ||
      event.eventType === 'item.superseded';
    if (!isValueEvent) continue;

    revisions.push({
      seq: event.seq,
      at: event.occurredAt,
      body: redacted ? null : body,
      previousBody: redacted ? null : previous,
      agentClient: event.agentClient,
      motivation: event.motivation,
    });
  }

  return revisions;
}

function disputesOf(
  event: MemoryEvent,
  redacted: boolean,
): CalendarEntry['disputes'] {
  const raw = event.payload['disputes'];
  if (!Array.isArray(raw)) return null;

  return raw.map((side) => {
    const row = side as Record<string, unknown>;
    return {
      shortId: (row['short_id'] as ShortId | undefined) ?? null,
      body: redacted ? null : (row['body'] as string | undefined) ?? null,
      authorName: (row['author_name'] as string | undefined) ?? null,
    };
  });
}

/**
 * Provenance for events written before the log carried any.
 *
 * A client and a session ref is a conversation; `web` with no session is the person
 * typing into the app. Deriving it rather than rendering "okänd källa" is what keeps
 * "hur vet du det om mig?" answerable for the memories saved before anyone thought about
 * provenance — which is most of them.
 */
function fallbackSource(event: MemoryEvent): MemorySource | null {
  if (!event.agentClient && !event.sessionRef) return null;
  return deriveSource({
    agentClient: event.agentClient as AgentClient | null,
    sessionRef: event.sessionRef,
  });
}
