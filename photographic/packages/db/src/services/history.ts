/**
 * History, and the answer to "how do you know that about me?". Backed by `app.event`;
 * see `MemoryHistory` for the allowlist reasoning.
 */

import type {
  Actor,
  EmbeddingProvenance,
  HistoryAction,
  HistoryEntry,
  HistoryPort,
  ItemKind,
  MemoryChange,
  MemoryChangeStep,
  MemoryEvent,
  Provenance,
  RoomId,
  ShortId,
} from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows } from '../pool.js';
import {
  EVENT_COLUMNS_PREFIXED,
  ITEM_COLUMNS,
  mapEvent,
  mapItem,
  mapSource,
  type EventRow,
  type ItemRow,
} from '../rows.js';
import { accessibleRoomIds, canRead } from './permissions.js';

const ACTION_OF: Record<string, HistoryAction> = {
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
  // The emergency sign-in. Listed here and in `MemoryHistory`'s copy of this map, which
  // has to stay identical: two implementations of the same feed disagreeing about what a
  // person can see is the drift the acceptance suite exists to catch.
  'session.break_glass_minted': 'break_glass_minted',
  'session.break_glass_used': 'break_glass_used',
};

export const DEFAULT_HISTORY_LIMIT = 100;

export class PgHistory implements HistoryPort {
  constructor(private readonly pool: Pool) {}

  async list(
    actor: Actor,
    input: { roomId?: RoomId; since?: Date; limit?: number } = {},
  ): Promise<HistoryEntry[]> {
    const scope = input.roomId
      ? (await canRead(this.pool, actor.personId, input.roomId)) ? [input.roomId] : []
      : await accessibleRoomIds(this.pool, actor.personId);
    if (scope.length === 0) return [];

    const rows = await queryRows<EventRow & { room_title: string; actor_name: string | null }>(
      this.pool,
      `SELECT ${EVENT_COLUMNS_PREFIXED}, r.title AS room_title, p.display_name AS actor_name
       FROM app.event e
       JOIN app.room r ON r.id = e.room_id
       LEFT JOIN app.person p ON p.id = e.actor_person_id
       WHERE e.room_id = ANY($1::uuid[])
         AND e.event_type = ANY($2::text[])
         AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
       ORDER BY e.seq DESC
       LIMIT $4`,
      [scope, Object.keys(ACTION_OF), input.since ?? null, input.limit ?? DEFAULT_HISTORY_LIMIT],
    );

    return rows.map((row) => toEntry(row));
  }

  async provenance(actor: Actor, shortId: ShortId, roomId?: RoomId): Promise<Provenance | null> {
    // Two different sets. `readable` is every room this person may see and bounds the
    // history; `lookup` is where the caller says the memory is, and only disambiguates
    // a short id. Narrowing the history to `lookup` too would drop the event a move
    // wrote in the room the memory came *from*, which is the half of "it used to live
    // somewhere else" that matters.
    const readable = await accessibleRoomIds(this.pool, actor.personId);
    const lookup = roomId ? readable.filter((id) => id === roomId) : readable;
    if (lookup.length === 0) return null;

    const itemRow = await queryOne<ItemRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS} FROM app.item WHERE short_id = $1 AND room_id = ANY($2::uuid[])`,
      [shortId, lookup],
    );
    if (!itemRow) return null;
    const item = mapItem(itemRow);
    if (!(await canRead(this.pool, actor.personId, item.roomId))) return null;

    // Which model has seen this text. Part of the same question the rest of this method
    // answers: semantic search works by sending a memory's own words to an embedding
    // model, and "did my text go to a third party" is something a person should be able
    // to ask of their own memory rather than read in a policy document.
    const embeddingRow = await queryOne<{
      embedding_model: string | null;
      embedding_provider: string | null;
      embedded_at: Date | null;
    }>(
      this.pool,
      `SELECT embedding_model, embedding_provider, embedded_at FROM app.item WHERE id = $1`,
      [item.id],
    );

    const roomTitle = await queryOne<{ title: string }>(this.pool, `SELECT title FROM app.room WHERE id = $1`, [
      item.roomId,
    ]);

    // Two conditions that look like belt-and-braces and are not.
    //
    // `room_id = ANY(readable)` is the permission filter every read owes. Without it the
    // query trusted that an event mentioning this item is an event about a room this
    // person may see, and a move writes one in a room they may have left.
    //
    // `payload @> ...` rather than `payload ->> 'item_id' = ...` because the only index
    // on this column is `event_payload_idx`, a `jsonb_path_ops` GIN index, and it can
    // only answer containment. The `->>` form ignored it and scanned every event on the
    // platform — bearable when the only caller was a page nobody could reach, and not
    // once there is a link on every memory row.
    const eventRows = await queryRows<EventRow & { room_title: string; actor_name: string | null }>(
      this.pool,
      `SELECT ${EVENT_COLUMNS_PREFIXED}, r.title AS room_title, p.display_name AS actor_name
       FROM app.event e
       JOIN app.room r ON r.id = e.room_id
       LEFT JOIN app.person p ON p.id = e.actor_person_id
       WHERE e.event_type = ANY($1::text[])
         AND e.payload @> jsonb_build_object('item_id', $2::text)
         AND e.room_id = ANY($3::uuid[])
       ORDER BY e.seq ASC`,
      [Object.keys(ACTION_OF), item.id, readable],
    );

    const timeline = eventRows.map((row) => toEntry(row));
    const created = eventRows.find(
      (r) => r.event_type === 'item.created' || r.event_type === 'item.shared',
    );

    let approvedByName: string | null = null;
    if (created?.approved_by) {
      const approver = await queryOne<{ display_name: string | null }>(
        this.pool,
        `SELECT display_name FROM app.person WHERE id = $1`,
        [created.approved_by],
      );
      approvedByName = approver?.display_name ?? null;
    }

    return {
      shortId: item.shortId,
      body: item.body,
      roomTitle: roomTitle?.title ?? '',
      savedAt: item.createdAt,
      savedByClient: created?.agent_client ?? null,
      approvedByName,
      // The two questions section 4 asks that a timeline alone cannot answer: why it was
      // stored where it is, and where the information came from.
      motivation: created?.motivation ?? null,
      source: created ? mapSource(created) : null,
      changed: eventRows.some(
        (r) => r.event_type === 'item.updated' || r.event_type === 'item.superseded',
      ),
      timeline,
      embedding: embeddingProvenanceOf(embeddingRow),
    };
  }

  /**
   * Every value a memory has held, across the supersede chain. See `HistoryPort.changes`.
   *
   * Two recursive walks and then the events. `forward` follows `superseded_by` from each
   * supplied short id to the end of its chain, so any id in a chain resolves to the same
   * head; `chain` then walks back from that head collecting every item that was ever
   * replaced by something in it. The `UNION` (rather than `UNION ALL`) is what makes a
   * cycle terminate instead of running forever — `superseded_by` is application-written
   * and a loop is a bug, not an impossibility.
   *
   * The head must be `active`, in a room the actor can read. That is the safety property
   * of this method: the steps below contain text the person has replaced, and returning
   * them for something in the trash would resurface a body a deletion was supposed to
   * take out of view.
   */
  async changes(
    actor: Actor,
    shortIds: ShortId[],
    input: { limit?: number } = {},
  ): Promise<MemoryChange[]> {
    if (shortIds.length === 0) return [];

    const scope = await accessibleRoomIds(this.pool, actor.personId);
    if (scope.length === 0) return [];

    const heads = await queryRows<{
      head_id: string;
      short_id: string;
      room_id: string;
      room_title: string;
      kind: ItemKind;
      body: string;
      created_at: Date;
      members: string[];
    }>(
      this.pool,
      `WITH RECURSIVE seed AS (
         SELECT i.id, i.superseded_by
         FROM app.item i
         WHERE i.short_id = ANY($1::text[]) AND i.room_id = ANY($2::uuid[])
       ),
       forward AS (
         SELECT id, superseded_by FROM seed
         UNION
         SELECT i.id, i.superseded_by
         FROM app.item i
         JOIN forward f ON i.id = f.superseded_by
       ),
       head AS (
         SELECT DISTINCT f.id FROM forward f WHERE f.superseded_by IS NULL
       ),
       chain AS (
         SELECT h.id AS head_id, h.id AS member_id FROM head h
         UNION
         SELECT c.head_id, i.id
         FROM app.item i
         JOIN chain c ON i.superseded_by = c.member_id
       )
       SELECT i.id AS head_id, i.short_id, i.room_id, r.title AS room_title, i.kind,
              i.body, i.created_at,
              array_agg(DISTINCT c.member_id::text) AS members
       FROM chain c
       JOIN app.item i ON i.id = c.head_id
       JOIN app.room r ON r.id = i.room_id
       WHERE i.status = 'active' AND i.room_id = ANY($2::uuid[])
       GROUP BY i.id, i.short_id, i.room_id, r.title, i.kind, i.body, i.created_at
       LIMIT $3`,
      [shortIds, scope, input.limit ?? 25],
    );

    if (heads.length === 0) return [];

    const memberIds = [...new Set(heads.flatMap((head) => head.members))];

    const eventRows = await queryRows<
      EventRow & { room_title: string; actor_name: string | null; item_id: string }
    >(
      this.pool,
      `SELECT ${EVENT_COLUMNS_PREFIXED}, r.title AS room_title, p.display_name AS actor_name,
              (e.payload ->> 'item_id') AS item_id
       FROM app.event e
       JOIN app.room r ON r.id = e.room_id
       LEFT JOIN app.person p ON p.id = e.actor_person_id
       WHERE e.event_type = ANY($1::text[])
         AND (e.payload ->> 'item_id') = ANY($2::text[])
       ORDER BY e.seq ASC`,
      [VALUE_EVENT_TYPES, memberIds],
    );

    const byItem = new Map<string, Array<(typeof eventRows)[number]>>();
    for (const row of eventRows) {
      const list = byItem.get(row.item_id) ?? [];
      list.push(row);
      byItem.set(row.item_id, list);
    }

    return heads
      .map((head) => {
        const events = head.members
          .flatMap((id) => byItem.get(id) ?? [])
          .sort((a, b) => Number(a.seq) - Number(b.seq));

        const steps = collapseValueSteps(events.map((row) => toChangeStep(row)));
        if (steps.length === 0) return null;

        return {
          shortId: head.short_id as ShortId,
          roomId: head.room_id as RoomId,
          roomTitle: head.room_title,
          currentBody: head.body,
          itemKind: head.kind,
          steps,
          firstSavedAt: steps[0]!.at,
          lastChangedAt: steps.at(-1)!.at,
          changeCount: steps.length - 1,
        } satisfies MemoryChange;
      })
      .filter((chain): chain is MemoryChange => chain !== null)
      .sort((a, b) => b.lastChangedAt.getTime() - a.lastChangedAt.getTime());
  }
}

/**
 * Which providers mean a memory's text left our servers.
 *
 * An allowlist of the ones that do *not*, so a provider nobody has classified here reads
 * as external. That is the safe direction for a disclosure: claiming text stayed local
 * when it did not is the failure that matters, and getting it wrong the other way only
 * over-discloses.
 */
const LOCAL_EMBEDDING_PROVIDERS = new Set(['fake']);

function embeddingProvenanceOf(
  row: { embedding_model: string | null; embedding_provider: string | null; embedded_at: Date | null } | null,
): EmbeddingProvenance | null {
  if (!row?.embedded_at || !row.embedding_provider) return null;

  return {
    provider: row.embedding_provider,
    model: row.embedding_model ?? 'okänd modell',
    external: !LOCAL_EMBEDDING_PROVIDERS.has(row.embedding_provider),
    at: row.embedded_at,
  };
}

/**
 * The event types that set a value, as opposed to happening around one.
 *
 * `item.restored` is absent on purpose: coming back from the trash does not change what
 * a memory says, and listing it as a change would make "hur har det ändrats" answer with
 * an administrative act.
 */
const VALUE_EVENT_TYPES: readonly string[] = [
  'item.created',
  'item.shared',
  'item.updated',
  'item.superseded',
];

function toChangeStep(
  row: EventRow & { room_title: string; actor_name: string | null },
): MemoryChangeStep {
  const event = mapEvent(row);
  const redacted = event.payload['redacted'] === true;
  const body = typeof event.payload['body'] === 'string' ? event.payload['body'] : null;
  const previous = typeof event.payload['previous'] === 'string' ? event.payload['previous'] : null;
  const shortId =
    typeof event.payload['short_id'] === 'string' ? (event.payload['short_id'] as ShortId) : null;

  return {
    seq: event.seq,
    at: event.occurredAt,
    body: redacted ? null : body,
    previousBody: redacted ? null : previous,
    shortId,
    action: ACTION_OF[event.eventType] ?? 'updated',
    agentClient: event.agentClient,
    actorName: row.actor_name,
    source: mapSource(row),
    motivation: event.motivation,
  };
}

/**
 * One step per distinct value, not one per event that mentioned it.
 *
 * A correction writes two events for one transition: `item.created` for the memory that
 * replaces (carrying `supersedes` and the text it replaced) and `item.superseded` for the
 * memory being replaced (carrying the same pair the other way round). Both are true and
 * both are needed — `resolveDispute` produces *only* the second, because the winner
 * already existed — but rendering both makes a single correction read as two.
 *
 * So consecutive steps that arrive at the same body collapse into one, keeping the
 * earlier event's provenance (the write that caused it) and the previous value from
 * whichever of the two recorded it. Deliberately keyed on the body rather than on the
 * event pair: it holds whether the pair was written in one transaction, in the other
 * order, or one without the other.
 */
export function collapseValueSteps(steps: MemoryChangeStep[]): MemoryChangeStep[] {
  const out: MemoryChangeStep[] = [];

  for (const step of steps) {
    const previousStep = out.at(-1);

    if (previousStep && previousStep.body !== null && previousStep.body === step.body) {
      out[out.length - 1] = {
        ...previousStep,
        previousBody: previousStep.previousBody ?? step.previousBody,
        // The superseded memory's short id is the more useful of the two here: it is what
        // `list_history` can still be pointed at to see where the old value came from.
        shortId: previousStep.shortId ?? step.shortId,
      };
      continue;
    }

    out.push(step);
  }

  return out;
}

function toEntry(row: EventRow & { room_title: string; actor_name: string | null }): HistoryEntry {
  const event = mapEvent(row);
  const redacted = event.payload['redacted'] === true;
  const body = typeof event.payload['body'] === 'string' ? event.payload['body'] : null;
  const shortId = typeof event.payload['short_id'] === 'string' ? (event.payload['short_id'] as ShortId) : null;

  return {
    seq: event.seq,
    action: ACTION_OF[event.eventType]!,
    occurredAt: event.occurredAt,
    roomId: event.roomId,
    roomTitle: row.room_title,
    shortId,
    body: redacted ? null : body,
    // Present on `item.created` and `item.shared` only; see `HistoryEntry.itemKind`.
    itemKind: isItemKind(event.payload['kind']) ? event.payload['kind'] : null,
    agentClient: event.agentClient,
    actorName: row.actor_name,
    wasApproved: event.approvedBy !== null,
    redacted,
  };
}

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
