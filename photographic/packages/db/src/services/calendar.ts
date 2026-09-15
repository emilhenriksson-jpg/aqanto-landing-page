/**
 * The calendar, backed by `app.memory_event` — a view over the log, not a table.
 *
 * See `MemoryCalendar` for the reasoning this mirrors. The one thing worth saying twice:
 * `body` comes out of the event payload rather than from `app.item`, which is the whole
 * difference between a log and a join. The item knows what a memory says now; the event
 * knows what it said that day, and a day is a record of what it said that day.
 *
 * Every query scopes to `app.accessible_room_ids`, because the view is as wide as the
 * table it reads and authorisation lives in the API layer by decision.
 */

import type {
  Actor,
  AgentClient,
  CalendarDay,
  CalendarEntry,
  CalendarPort,
  EventSeq,
  ItemKind,
  MemoryEventDetail,
  MemoryEventKind,
  MemoryRevision,
  MemorySource,
  MemorySourceDetail,
  PersonId,
  RoomId,
  RoomKind,
  SharedWith,
  ShortId,
  Transport,
} from '@photographic/core';
import {
  CALENDAR_EVENT_TYPES,
  DEFAULT_TIME_ZONE,
  MEMORY_EVENT_KINDS,
  calendarDateOf,
  calendarDayRange,
  daysRemaining,
  deriveSource,
  NotFoundError,
} from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows } from '../pool.js';
import { accessibleRoomIds, canRead } from './permissions.js';

/** One row of `app.memory_event`. */
interface MemoryEventRow {
  seq: string | number;
  occurred_at: Date;
  room_id: string;
  room_title: string;
  room_kind: RoomKind;
  event_type: string;
  kind: MemoryEventKind;
  item_id: string | null;
  short_id: string | null;
  item_kind: ItemKind | null;
  body: string | null;
  previous_body: string | null;
  shared_with: SharedWith[] | null;
  disputes: Array<{ short_id?: string; body?: string; author_name?: string }> | null;
  redacted: boolean;
  actor_person_id: string | null;
  actor_name: string | null;
  agent_client: AgentClient | null;
  client_id: string | null;
  session_ref: string | null;
  was_approved: boolean;
  motivation: string | null;
  explicit: boolean;
  source_kind: MemorySource['kind'] | null;
  source_label: string | null;
  source_ref: string | null;
  source_uri: string | null;
  from_room_id: string | null;
  from_room_title: string | null;
  to_room_id: string | null;
  to_room_title: string | null;
  /** Whether the memory was corrected after this event. The sixth provenance question. */
  changed: boolean;
}

const COLUMNS = `m.seq, m.occurred_at, m.room_id, m.room_title, m.room_kind, m.event_type, m.kind,
  m.item_id, m.short_id, m.item_kind, m.body, m.previous_body, m.shared_with, m.disputes,
  m.redacted, m.actor_person_id, m.actor_name, m.agent_client, m.client_id, m.session_ref,
  m.was_approved, m.motivation, m.explicit, m.source_kind, m.source_label, m.source_ref,
  m.source_uri, m.from_room_id, m.from_room_title, m.to_room_id, m.to_room_title,
  EXISTS (
    SELECT 1 FROM app.event later
    WHERE later.event_type IN ('item.updated', 'item.superseded')
      AND later.seq > m.seq
      AND m.item_id IS NOT NULL
      AND (later.payload ->> 'item_id')::uuid = m.item_id
  ) AS changed`;

export class PgCalendar implements CalendarPort {
  constructor(private readonly pool: Pool) {}

  async day(
    actor: Actor,
    input: { date: string; timeZone?: string; roomId?: RoomId },
  ): Promise<CalendarDay> {
    const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
    // Throws for a room this person may not read, before anything reads its title.
    const scope = await this.scopeFor(actor, input.roomId);
    // The range is computed in one place, in `@photographic/core`, and passed in as
    // absolute time. Doing timezone arithmetic in SQL as well would be a second
    // definition of midnight.
    const { from, to } = calendarDayRange(input.date, timeZone);

    const rows =
      scope.length === 0
        ? []
        : await queryRows<MemoryEventRow>(
            this.pool,
            `SELECT ${COLUMNS} FROM app.memory_event m
             WHERE m.room_id = ANY($1::uuid[])
               AND m.event_type = ANY($2::text[])
               AND m.occurred_at >= $3 AND m.occurred_at < $4
             ORDER BY m.seq ASC`,
            [scope, CALENDAR_EVENT_TYPES, from, to],
          );

    const entries = rows.map((row) => toEntry(row, actor.personId));

    const counts = Object.fromEntries(MEMORY_EVENT_KINDS.map((kind) => [kind, 0])) as Record<
      MemoryEventKind,
      number
    >;
    for (const entry of entries) counts[entry.kind] += 1;

    const room = input.roomId
      ? await queryOne<{ title: string }>(this.pool, `SELECT title FROM app.room WHERE id = $1`, [
          input.roomId,
        ])
      : null;

    return {
      date: input.date,
      timeZone,
      roomId: input.roomId ?? null,
      roomTitle: room?.title ?? null,
      entries,
      counts,
      byOthersCount: entries.filter((entry) => entry.byOtherMember).length,
      ...(await this.neighbours(scope, from, to, timeZone)),
    };
  }

  async event(actor: Actor, seq: EventSeq): Promise<MemoryEventDetail | null> {
    const row = await queryOne<MemoryEventRow>(
      this.pool,
      `SELECT ${COLUMNS} FROM app.memory_event m WHERE m.seq = $1`,
      [Number(seq)],
    );
    if (!row) return null;
    if (!(await canRead(this.pool, actor.personId, row.room_id as RoomId))) return null;

    const related = row.item_id
      ? await queryRows<MemoryEventRow>(
          this.pool,
          `SELECT ${COLUMNS} FROM app.memory_event m
           WHERE m.item_id = $1 AND m.event_type = ANY($2::text[])
           ORDER BY m.seq ASC`,
          [row.item_id, CALENDAR_EVENT_TYPES],
        )
      : [row];

    const current = row.item_id
      ? await queryOne<{ body: string; purge_after: Date | null }>(
          this.pool,
          `SELECT body, purge_after FROM app.item WHERE id = $1`,
          [row.item_id],
        )
      : null;

    const inTrash = row.item_id
      ? await queryOne<{ present: boolean }>(
          this.pool,
          `SELECT EXISTS (SELECT 1 FROM app.trash WHERE item_id = $1) AS present`,
          [row.item_id],
        )
      : null;

    return {
      entry: toEntry(row, actor.personId),
      timeline: related.map((r) => toEntry(r, actor.personId)),
      revisions: revisionsOf(related),
      source: await this.sourceDetail(actor, row),
      currentBody: current?.body ?? null,
      trash:
        inTrash?.present && current?.purge_after
          ? {
              purgeAfter: current.purge_after,
              daysRemaining: daysRemaining(current.purge_after, new Date()),
            }
          : null,
    };
  }

  /**
   * The rooms this reader may see, and a refusal rather than an empty answer.
   *
   * A named room the person cannot read used to come back as an empty scope, and the caller
   * carried on — `day()` then looked the title up with an unscoped
   * `SELECT title FROM app.room`, so a protected room answered 200 with its own name while a
   * fictional id answered 200 with `null`. Room names are frequently the sensitive part
   * ("Vårdplan", "Uppsägningar"), and the two different answers also made the id space
   * enumerable.
   *
   * `NotFoundError` for both cases, which is the rule the rest of the product already
   * follows: denied access is indistinguishable from nonexistence, down to the timing floor
   * `handleError` pads 404s to.
   */
  private async scopeFor(actor: Actor, roomId?: RoomId): Promise<RoomId[]> {
    if (roomId) {
      if (!(await canRead(this.pool, actor.personId, roomId))) {
        throw new NotFoundError('Rummet finns inte.');
      }
      return [roomId];
    }
    return accessibleRoomIds(this.pool, actor.personId);
  }

  /**
   * The last step of the zoom: day -> memory event -> source.
   *
   * `alsoFromHere` is what makes it a place rather than a label. One Claude session that
   * wrote four things reads as one conversation, which is how the person remembers it.
   */
  private async sourceDetail(
    actor: Actor,
    row: MemoryEventRow,
  ): Promise<MemorySourceDetail | null> {
    const source = sourceOf(row);
    if (!source) return null;

    const session = row.session_ref
      ? await queryOne<{ started_at: Date; transport: Transport }>(
          this.pool,
          `SELECT started_at, transport FROM app.client_session WHERE id = $1`,
          [row.session_ref],
        )
      : null;

    const alsoFromHere = source.ref
      ? await queryRows<{ seq: string; short_id: string | null; body: string | null; redacted: boolean }>(
          this.pool,
          `SELECT m.seq, m.short_id, m.body, m.redacted FROM app.memory_event m
           WHERE m.seq <> $1
             AND coalesce(m.source_ref, m.session_ref) = $2
             AND m.room_id = ANY (SELECT room_id FROM app.accessible_room_ids($3))
           ORDER BY m.seq ASC
           LIMIT 20`,
          [Number(row.seq), source.ref, actor.personId],
        )
      : [];

    return {
      ...source,
      at: session?.started_at ?? null,
      agentClient: row.agent_client,
      transport: session?.transport ?? null,
      alsoFromHere: alsoFromHere.map((r) => ({
        seq: Number(r.seq) as EventSeq,
        shortId: (r.short_id as ShortId | null) ?? null,
        body: r.redacted ? null : r.body,
      })),
    };
  }

  /**
   * The nearest day on either side that has anything in it.
   *
   * Stepping one empty day at a time through a quiet week is how a calendar gets
   * abandoned, so the arrows point at days that exist rather than at tomorrow.
   */
  private async neighbours(
    scope: RoomId[],
    from: Date,
    to: Date,
    timeZone: string,
  ): Promise<{ previousDate: string | null; nextDate: string | null }> {
    if (scope.length === 0) return { previousDate: null, nextDate: null };

    const row = await queryOne<{ previous: Date | null; next: Date | null }>(
      this.pool,
      `SELECT
         (SELECT max(occurred_at) FROM app.memory_event
          WHERE room_id = ANY($1::uuid[]) AND event_type = ANY($2::text[]) AND occurred_at < $3) AS previous,
         (SELECT min(occurred_at) FROM app.memory_event
          WHERE room_id = ANY($1::uuid[]) AND event_type = ANY($2::text[]) AND occurred_at >= $4) AS next`,
      [scope, CALENDAR_EVENT_TYPES, from, to],
    );

    return {
      previousDate: row?.previous ? calendarDateOf(row.previous, timeZone) : null,
      nextDate: row?.next ? calendarDateOf(row.next, timeZone) : null,
    };
  }
}

function toEntry(row: MemoryEventRow, viewer: PersonId): CalendarEntry {
  const redacted = row.redacted;

  return {
    seq: Number(row.seq) as EventSeq,
    kind: row.kind,
    occurredAt: row.occurred_at,
    body: redacted ? null : row.body,
    previousBody: redacted ? null : row.previous_body,
    shortId: row.short_id as ShortId | null,
    itemKind: row.item_kind,
    fromRoomTitle: row.from_room_title,
    toRoomTitle: row.to_room_title,
    sharedWith: row.shared_with,
    disputes:
      row.disputes?.map((side) => ({
        shortId: (side.short_id as ShortId | undefined) ?? null,
        body: redacted ? null : side.body ?? null,
        authorName: side.author_name ?? null,
      })) ?? null,
    provenance: {
      learnedAt: row.occurred_at,
      agentClient: row.agent_client,
      actorName: row.actor_name,
      source: sourceOf(row),
      roomId: row.room_id as RoomId,
      roomTitle: row.room_title,
      roomKind: row.room_kind,
      motivation: row.motivation,
      explicit: row.explicit,
      wasApproved: row.was_approved,
      changed: row.changed,
    },
    // Somebody else did this, in a room shared with them. Nothing gates incoming material
    // from the other members, so noticing it is the whole defence.
    byOtherMember:
      row.room_kind === 'shared' &&
      row.actor_person_id !== null &&
      row.actor_person_id !== viewer,
    redacted,
  };
}

/**
 * Provenance for events written before the log carried any.
 *
 * A client plus a session ref is a conversation; `web` with no session is the person
 * typing into the app. Deriving it rather than rendering "okänd källa" is what keeps "hur
 * vet du det om mig?" answerable for memories saved before anyone thought about
 * provenance — which is most of them.
 */
function sourceOf(row: MemoryEventRow): MemorySource | null {
  if (row.source_kind) {
    return {
      kind: row.source_kind,
      label: row.source_label ?? '',
      ref: row.source_ref,
      uri: row.source_uri,
    };
  }
  if (!row.agent_client && !row.session_ref) return null;
  return deriveSource({ agentClient: row.agent_client, sessionRef: row.session_ref });
}

/** Every value a memory has held, oldest first. See `revisionsOf` in services-memory. */
function revisionsOf(rows: MemoryEventRow[]): MemoryRevision[] {
  return rows
    .filter((row) =>
      ['item.created', 'item.shared', 'item.updated', 'item.superseded'].includes(row.event_type),
    )
    .map((row) => ({
      seq: Number(row.seq) as EventSeq,
      at: row.occurred_at,
      body: row.redacted ? null : row.body,
      previousBody: row.redacted ? null : row.previous_body,
      agentClient: row.agent_client,
      motivation: row.motivation,
    }));
}
