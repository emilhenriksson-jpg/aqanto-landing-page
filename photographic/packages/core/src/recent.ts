/**
 * "Recent" for the session-start package — a seam, not a feature.
 *
 * Track 2 is rebuilding the event log this call site reads from: new event kinds
 * (`item.superseded`, `member.left`, disputes), an author column, richer provenance.
 * None of that changes what "recent" needs from it — an actor and a limit in, the most
 * recent entries that actor may see out, newest first. `HistoryPort.list` already reads
 * `app.event`, already applies the room-isolation choke point, and already carries the
 * event-type allowlist that keeps job bookkeeping out of what a person or a model sees.
 * So this calls it directly today rather than inventing a second history reader to
 * retire later.
 *
 * The reason this is its own function and not just an inline `history.list(actor, {
 * limit })` at each bundle call site: when the richer log lands and "recent" needs to
 * become something history.list itself cannot express — a cross-room digest collapsed
 * to one line per room, say, or a summary rather than raw events — this is the one place
 * that changes. `MemoryBundle` and `PgBundle` do not move.
 */

import type { HistoryEntry } from './domain.js';
import type { Actor, HistoryPort } from './ports.js';
import { RECENT_ACTIVITY_LIMIT } from './policy.js';

/**
 * Fetched wider than the final count so collapsing to one line per memory (below)
 * still leaves enough entries to fill the limit. Five times over is generous for a
 * limit this small and still a cheap, bounded read.
 */
const FETCH_MULTIPLIER = 5;

export async function recentActivityFor(
  history: Pick<HistoryPort, 'list'>,
  actor: Actor,
  limit: number = RECENT_ACTIVITY_LIMIT,
): Promise<HistoryEntry[]> {
  const raw = await history.list(actor, { limit: limit * FETCH_MULTIPLIER });
  return collapseToLatestPerItem(raw, limit);
}

/**
 * One line per memory, not one line per thing that happened to it.
 *
 * `HistoryPort.list` is a feed: every event on its own line, oldest-safe, which is
 * right for `list_history`. "Recent" is not a feed — it is a handful of lines a model
 * reads without asking, and a memory that was saved and then deleted inside the same
 * short window has to show up as *deleted*, once, not as "saved: <body>" followed by
 * "deleted" two lines later. Keeping only the newest event per short id is what keeps
 * the promise that a deleted memory's text does not resurface here: the stale `saved`
 * line naming its body never survives the collapse once a later `deleted` exists.
 *
 * Entries with no short id (a room being created, someone joining) have nothing to
 * collapse against and pass through unchanged.
 */
function collapseToLatestPerItem(entries: HistoryEntry[], limit: number): HistoryEntry[] {
  const seen = new Set<string>();
  const collapsed: HistoryEntry[] = [];

  for (const entry of entries) {
    const key = entry.shortId ?? `seq:${entry.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);

    collapsed.push(entry);
    if (collapsed.length >= limit) break;
  }

  return collapsed;
}
