/**
 * "Fråga mitt minne" — scope §7.
 *
 * One function, because the person does not experience "search" and "calendar" as two
 * features: "vad bestämde vi om Photographic igår" is a single question that happens to
 * need both a text match and a date. This composes two ports that already enforce room
 * isolation on their own — `RetrievalPort.search` and `HistoryPort.list` — rather than
 * adding a third place that could get the choke point wrong. Nothing here queries a
 * table directly.
 *
 * What it deliberately does not do: reimplement document search or a second index.
 * `RetrievalPort.search` already returns document chunks alongside memories, unchanged,
 * for a plain text query — that is the platform track's surface and it is left exactly
 * as it works today. The one place documents are *not* folded in is the calendar path:
 * a chunk carries no date a person recognises as "when this happened" yet, so a
 * date-scoped ask omits them rather than guessing. See `SearchHit.createdAt`.
 */

import type { AskHit, AskHitKind, HistoryAction, HistoryEntry, RoomId } from './domain.js';
import type { Actor, HistoryPort, RetrievalPort, RoomPort } from './ports.js';
import { swedishTerms } from './swedish.js';

export type AskSort = 'relevance' | 'oldest' | 'newest';

export interface AskInput {
  /** Free text. Optional: "vad hände igår" is a valid question with no keyword in it. */
  query?: string;
  roomIds?: RoomId[];
  /** Inclusive lower bound. The caller (a model that already knows today's date, or
   * the web form) is expected to turn "igår" / "förra måndagen" into a concrete date —
   * same convention as everywhere else in this product that a natural-language time
   * expression meets a tool boundary. */
  since?: Date;
  /** Inclusive upper bound. */
  until?: Date;
  /**
   * `'relevance'` (default with a query) ranks by match strength. `'oldest'` and
   * `'newest'` ignore relevance entirely and answer "when did this start" / "what
   * happened most recently" — the two questions relevance ranking answers badly,
   * because the first mention of a long-running topic is rarely the strongest textual
   * match for it.
   */
  sort?: AskSort;
  limit?: number;
}

export const DEFAULT_ASK_LIMIT = 10;

/**
 * How many history entries to pull before filtering, per room scanned.
 *
 * There is no free-text index on `app.event` yet (build-plan decision 6: Postgres FTS
 * for items, no new indexes for the log), so a date- or keyword-bounded history search
 * loads a bounded window and filters it in the process — the same interim shape
 * `PgRetrieval` already uses for items, kept small enough that the eventual move to a
 * real query does not change this function's contract, only what backs it.
 */
const HISTORY_SCAN_LIMIT = 300;

/**
 * Which actions may repeat their memory's text in a calendar hit.
 *
 * An allowlist, the same shape and for the same reason `ACTION_OF` in `HistoryPort` is
 * one: `saved`, `updated` and `restored` are a memory's current, visible content.
 * Everything else is either not a decision yet — `proposed`/`approved`/`rejected`, a
 * proposal is not something that happened until a person says so, and showing its text
 * here would make it look decided before the Godkänn-kön did — or the opposite of
 * visible: `deleted`/`purged` (and a future `superseded`) are the actions whose whole
 * point is that the text stops reaching a model, and a searchable calendar must not be
 * the exception that undoes that. The event still appears — the room and that
 * something happened is useful on its own — only the text is withheld.
 */
const ASK_BODY_ALLOWED: ReadonlySet<HistoryAction> = new Set(['saved', 'updated', 'restored']);

/** The subset of `Services` this needs — named, and narrowed to one method each, so a
 * caller does not have to construct (or a test fake) the rest of three whole ports. */
export interface AskServices {
  retrieval: Pick<RetrievalPort, 'search'>;
  history: Pick<HistoryPort, 'list'>;
  rooms: Pick<RoomPort, 'listForPerson'>;
}

export async function askMemory(services: AskServices, actor: Actor, input: AskInput): Promise<AskHit[]> {
  const query = input.query?.trim() || undefined;
  const limit = input.limit ?? DEFAULT_ASK_LIMIT;

  // Sort 'oldest' implies "when did this start", which the current item alone cannot
  // always answer — the first mention may since have been deleted, or only survive as
  // an update to something that now reads differently. Reaching into history for it is
  // what makes the difference between "when did we start discussing this" working only
  // for topics nobody has touched since, and working in general.
  const wantsCalendar = Boolean(input.since || input.until || input.sort === 'oldest');

  if (!query && !wantsCalendar) return [];

  const roomTitles = await roomTitleIndex(services.rooms, actor);

  const rawMemoryHits = query
    ? await services.retrieval.search(actor, {
        query,
        ...(input.roomIds?.length ? { roomIds: input.roomIds } : {}),
        // Over-fetched: date filtering below (when the ask is calendar-scoped) removes
        // hits after the fact, and the final slice still lands on `limit`.
        limit: limit * 3,
      })
    : [];

  const memoryHits = rawMemoryHits
    .map((hit): AskHit => ({
      kind: hit.kind === 'chunk' ? 'document' : 'memory',
      roomId: hit.roomId,
      roomTitle: roomTitles.get(hit.roomId) ?? '',
      text: hit.text,
      score: hit.score,
      occurredAt: hit.createdAt,
      shortId: hit.shortId,
      documentId: hit.documentId,
      seq: null,
      action: null,
    }))
    .filter((hit) => inRange(hit, input));

  const eventHits = wantsCalendar
    ? await eventsInRange(services.history, actor, input, roomTitles)
    : [];

  const sort: AskSort = input.sort ?? (query ? 'relevance' : 'newest');

  return mergeRanked(memoryHits, eventHits, sort).slice(0, limit);
}

/**
 * A hit with no date can only be excluded from a date-scoped ask, never assumed to
 * qualify. Today that means every document chunk — see the file comment.
 */
function inRange(hit: AskHit, input: AskInput): boolean {
  if (!input.since && !input.until) return true;
  if (!hit.occurredAt) return false;
  const t = hit.occurredAt.getTime();
  if (input.since && t < input.since.getTime()) return false;
  if (input.until && t > input.until.getTime()) return false;
  return true;
}

async function eventsInRange(
  history: Pick<HistoryPort, 'list'>,
  actor: Actor,
  input: AskInput,
  roomTitles: Map<RoomId, string>,
): Promise<AskHit[]> {
  const rooms = input.roomIds?.length ? input.roomIds : [undefined];

  const collected: HistoryEntry[] = [];
  for (const roomId of rooms) {
    const entries = await history.list(actor, {
      ...(roomId ? { roomId } : {}),
      ...(input.since ? { since: input.since } : {}),
      limit: HISTORY_SCAN_LIMIT,
    });
    collected.push(...entries);
  }

  const bounded = input.until
    ? collected.filter((entry) => entry.occurredAt.getTime() <= input.until!.getTime())
    : collected;

  // One line per memory within the window, not one per thing that happened to it — see
  // `collapseToLatestPerItem`. Without this, a memory saved and later deleted inside
  // the same window would surface both its `saved` line (body and all) and its
  // `deleted` line, defeating the body allowlist below: the earlier `saved` event for
  // the very same memory is still, on its own, an allowed action.
  const collapsed = collapseToLatestPerItem(bounded);

  const scored = input.query
    ? lexicallyScore(input.query, collapsed)
    : collapsed.map((entry) => ({ entry, score: 1 }));

  return scored.map(({ entry, score }): AskHit => ({
    kind: 'event' as AskHitKind,
    roomId: entry.roomId,
    roomTitle: roomTitles.get(entry.roomId) ?? entry.roomTitle,
    text: ASK_BODY_ALLOWED.has(entry.action) ? entry.body ?? '' : '',
    score,
    occurredAt: entry.occurredAt,
    shortId: entry.shortId,
    documentId: null,
    seq: entry.seq,
    action: entry.action,
  }));
}

/**
 * Keeps only the newest event per memory within the fetched window.
 *
 * `history.list` is oldest-unsafe in the sense that it is a feed — every event on its
 * own line, which is right for `list_history`. A calendar-scoped ask is not a feed: a
 * memory saved and then deleted inside the same window has to appear as *deleted*,
 * once, not as "saved: <body>" followed by "deleted" — the earlier line is exactly the
 * one the deletion was supposed to remove from anything a model can see. Entries with
 * no short id (a room being created, a member joining) have nothing to collapse
 * against and pass through unchanged.
 *
 * Scoped to what was actually fetched: a deletion that lands after the window's
 * `until` bound is not in `entries` at all, so this cannot reach past the window to
 * suppress it. That is a real, narrower limitation than "recent"'s version of the same
 * rule, which always looks at the true newest event regardless of any window.
 */
function collapseToLatestPerItem(entries: HistoryEntry[]): HistoryEntry[] {
  // `history.list` returns newest-first; keep that order so the first occurrence of a
  // shortId here already is the newest.
  const seen = new Set<string>();
  const collapsed: HistoryEntry[] = [];

  for (const entry of entries) {
    const key = entry.shortId ?? `seq:${entry.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    collapsed.push(entry);
  }

  return collapsed;
}

/**
 * The same stemmed-term-overlap stand-in `MemoryRetrieval`/`PgRetrieval` use for
 * lexical ranking, applied to history bodies via the shared `swedishTerms` — one
 * suffix list, used everywhere something needs to know that "godkänt" and "godkände"
 * are close enough to count. An entry with no body (a room being created, a member
 * joining) or a redacted one cannot match text and is correctly absent rather than
 * scored zero-but-included.
 */
function lexicallyScore(query: string, entries: HistoryEntry[]): Array<{ entry: HistoryEntry; score: number }> {
  const queryTerms = swedishTerms(query);
  if (queryTerms.length === 0) return [];

  return entries
    .map((entry) => {
      const entryTerms = new Set(swedishTerms(entry.body ?? ''));
      let score = 0;
      for (const term of queryTerms) {
        if (entryTerms.has(term)) score += term.length;
      }
      return { entry, score };
    })
    .filter((x) => x.score > 0);
}

/**
 * Merges two arms whose scores are not on the same scale.
 *
 * Relevance ranking normalises each arm to its own maximum before merging — cheap,
 * order-preserving within an arm, and honest about the fact that a 0.03 from RRF fusion
 * and a 12 from term-length scoring were never comparable numbers to begin with.
 * `'oldest'`/`'newest'` skip scoring entirely and answer a different question, so they
 * sort on `occurredAt` instead — a memory's `occurredAt` is when it was saved, an
 * event's is when it happened, and both answer "when" the same way.
 */
function mergeRanked(memoryHits: AskHit[], eventHits: AskHit[], sort: AskSort): AskHit[] {
  if (sort === 'oldest') {
    return [...memoryHits, ...eventHits].sort(byTime(1));
  }
  if (sort === 'newest') {
    return [...memoryHits, ...eventHits].sort(byTime(-1));
  }

  return [...normalise(memoryHits), ...normalise(eventHits)].sort((a, b) => b.score - a.score);
}

function byTime(direction: 1 | -1): (a: AskHit, b: AskHit) => number {
  return (a, b) => direction * ((a.occurredAt?.getTime() ?? 0) - (b.occurredAt?.getTime() ?? 0));
}

function normalise(hits: AskHit[]): AskHit[] {
  const max = hits.reduce((m, hit) => Math.max(m, hit.score), 0);
  if (max <= 0) return hits;
  return hits.map((hit) => ({ ...hit, score: hit.score / max }));
}

async function roomTitleIndex(rooms: Pick<RoomPort, 'listForPerson'>, actor: Actor): Promise<Map<RoomId, string>> {
  const summaries = await rooms.listForPerson(actor);
  return new Map(summaries.map((room) => [room.roomId, room.title]));
}
