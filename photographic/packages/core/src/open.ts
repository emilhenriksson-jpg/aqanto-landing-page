/**
 * What the person left hanging — the block that turns a dossier into an opening.
 *
 * `docs/agent-instruction-layer.md` set this aside as one of three things on the list
 * that are "asking Photographic to *do* something, not to *be* some way", and said
 * exactly what it would need: *"'Ask how something went' needs the calendar. The model
 * has to know that something was said three weeks ago and hasn't been followed up on —
 * that's a query over history, not a disposition."* This is that query, so this is
 * finishing an idea the project already had rather than a new one.
 *
 * Why it matters more than its two lines suggest. Everything else in the session package
 * describes: who the person is, what they prefer, what their rooms are, what happened
 * lately. None of it is *unfinished*, so a model reading it can only recite. One line
 * saying "this was decided three weeks ago and nothing has happened since" is the
 * difference between being recited at and being picked up mid-thread, and it is the
 * thing a person recognises as being remembered rather than filed.
 *
 * ## What counts as open
 *
 * Derived entirely from the log, with no new write, no new table and no model call — the
 * same reasoning `recentActivityFor` uses, and for the same reason: a flag somebody has
 * to remember to set is a flag that is wrong.
 *
 * A memory is open when all four hold:
 *
 *  1. **Its kind implies an outcome.** Only `decision` and `note`. A `fact`, a
 *     `preference`, an `identity` line, an `instruction`, a `never` or a `compass`
 *     principle is durable by nature — "Allergisk mot ketchup" is not waiting on
 *     anything, and listing it as unfinished would be worse than listing nothing,
 *     because it teaches a model that this block means nothing.
 *  2. **Nothing has happened to it since it was written.** The newest event about it is
 *     `saved` or `updated`. Anything else — deleted, superseded, disputed, restored —
 *     *is* a follow-up, and a memory that was corrected last week is the opposite of
 *     neglected.
 *  3. **It is old enough to have been dropped rather than to be in progress.**
 *     `OPEN_THREAD_MIN_AGE_DAYS`. Something saved yesterday is not a loose end, it is
 *     today's work, and asking about it reads as not having been listening.
 *  4. **It is recent enough to still be a thread.** `OPEN_THREAD_MAX_AGE_DAYS`. A note
 *     from eight months ago is not unfinished business; it is the past, and raising it
 *     is the behaviour that makes a model feel like it is reading a file on you.
 *
 * Oldest first, because the longest-ignored thing is the one worth asking about, and
 * capped hard: this is a conversational opening, not a to-do list. A model handed six
 * open threads will list them.
 *
 * ## What it deliberately does not do
 *
 * It does not claim the memory is *unresolved in the world* — only that Photographic has
 * heard nothing since. Those are different, and the renderer says the second rather than
 * asserting the first, because the person may well have finished the thing and not
 * mentioned it. A model that says "har du hunnit med X?" is right either way; one that
 * says "X är fortfarande öppet" is wrong half the time.
 */

import type { HistoryEntry, ItemKind, OpenThread, ShortId } from './domain.js';
import type { Actor, HistoryPort } from './ports.js';
import {
  OPEN_THREAD_LIMIT,
  OPEN_THREAD_MAX_AGE_DAYS,
  OPEN_THREAD_MIN_AGE_DAYS,
} from './policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Kinds that can be unfinished. See reason 1 in the file comment.
 *
 * An allowlist rather than a denylist, the same shape as every other rule in this
 * product that decides what may reach a model: a kind added later is silently *not*
 * treated as an open thread until somebody decides it should be, which is the safe
 * direction for a block whose whole value is that every line in it is worth asking about.
 */
const OPEN_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(['decision', 'note']);

/** Actions that mean nothing has followed. See reason 2. */
const UNFOLLOWED_ACTIONS: ReadonlySet<HistoryEntry['action']> = new Set(['saved', 'updated']);

/**
 * How much log to read.
 *
 * Bounded like every other read on the session-start path. It is deliberately wider than
 * `recentActivityFor`'s window, because this looks for the *absence* of activity and so
 * has to see far enough back to find something that stopped — but it is still one
 * indexed read with a limit, not a scan.
 */
const SCAN_LIMIT = 300;

export async function openThreadsFor(
  history: Pick<HistoryPort, 'list'>,
  actor: Actor,
  now: Date,
  limit: number = OPEN_THREAD_LIMIT,
): Promise<OpenThread[]> {
  const since = new Date(now.getTime() - OPEN_THREAD_MAX_AGE_DAYS * DAY_MS);
  const entries = await history.list(actor, { since, limit: SCAN_LIMIT });

  // `history.list` is newest-first, so the first entry seen for a short id is its newest
  // event and every later one is older. Both are needed: the newest decides whether
  // anything has followed, and the creation event is the only one carrying the kind.
  const newest = new Map<ShortId, HistoryEntry>();
  const kinds = new Map<ShortId, ItemKind>();

  for (const entry of entries) {
    if (!entry.shortId) continue;
    if (!newest.has(entry.shortId)) newest.set(entry.shortId, entry);
    if (entry.itemKind && !kinds.has(entry.shortId)) kinds.set(entry.shortId, entry.itemKind);
  }

  const open: OpenThread[] = [];

  for (const [shortId, entry] of newest) {
    const kind = kinds.get(shortId);
    // No kind in the window means the memory was created before it. Excluded rather than
    // assumed: this block is only worth having if every line in it is worth asking about,
    // and the cost of the omission is that a long-lived memory has to be re-mentioned
    // once before it can read as neglected.
    if (!kind || !OPEN_KINDS.has(kind)) continue;
    if (!UNFOLLOWED_ACTIONS.has(entry.action)) continue;
    if (!entry.body || entry.redacted) continue;

    const daysSince = Math.floor((now.getTime() - entry.occurredAt.getTime()) / DAY_MS);
    if (daysSince < OPEN_THREAD_MIN_AGE_DAYS) continue;
    if (daysSince > OPEN_THREAD_MAX_AGE_DAYS) continue;

    open.push({
      shortId,
      roomId: entry.roomId,
      roomTitle: entry.roomTitle,
      body: entry.body,
      kind,
      lastTouchedAt: entry.occurredAt,
      daysSince,
    });
  }

  // Longest-ignored first: that is the one worth asking about, and it is also the one a
  // person is most likely to have forgotten they told us.
  return open.sort((a, b) => b.daysSince - a.daysSince).slice(0, limit);
}
