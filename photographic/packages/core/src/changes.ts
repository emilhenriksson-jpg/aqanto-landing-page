/**
 * "Hur har X ändrats över tid" — scope §5 and §9, and the sentence the product is built
 * around: *"Ändras 15 oktober till 1 november ska historiken visa både den ursprungliga
 * uppgiften och korrigeringen."*
 *
 * A memory that can only tell you its current value is a database. The thing that makes
 * it a memory is being able to show how it got there — what it used to be, what replaced
 * it, when, and where that came from.
 *
 * This is deliberately not a third search index. It composes what already exists:
 *
 *  - `RetrievalPort.search` finds memories whose *current* text matches, which is how a
 *    question phrased in today's words reaches a chain.
 *  - `HistoryPort.list` finds events whose text matches, which is how a question phrased
 *    in the *old* words reaches the same chain — "när bodde jag i Stockholm" has to work
 *    after the memory says Göteborg, and search cannot find text that is no longer
 *    current by definition.
 *  - `HistoryPort.changes` walks the supersede links and assembles the chain.
 *
 * Why the chain needs walking at all: `IngestPort` treats a contradiction within one
 * author as a correction, and a correction writes a *new* item and supersedes the old
 * one. So the previous value lives on a different row with a different short id, and the
 * per-item timeline `provenance` returns stops at the row it was asked about. Following
 * `superseded_by` is the difference between "this memory has never changed" (true of the
 * row, false of the fact) and the actual history.
 *
 * ## The leak this must not have
 *
 * The steps carry text the person has replaced, and in one case text they have
 * *deleted*. A superseded body resurfacing for a memory that has since been deleted has
 * been fixed twice in this repo already — once in `recent.ts`, where a deleted memory's
 * own earlier `item.created` event brought its body back, and once in `ask.ts`, where a
 * save and a delete inside the same window both matched and the `saved` line won. Both
 * were closed with an allowlist over *actions*, which cannot help here: the whole point
 * of this feature is to show exactly the bodies those allowlists exclude.
 *
 * So the rule is about the *head* of the chain rather than about any step: a chain is
 * only ever shown for a memory that exists right now. If what the chain leads to is in
 * the trash, purged, or unreadable, there is no chain — not a shortened one. Enforced in
 * two independent places, because two was the right number the last two times: the
 * storage query refuses a non-`active` head (see `HistoryPort.changes`), and
 * `dropDeletedHeads` below refuses it again on the way out.
 */

import type { HistoryEntry, MemoryChange, RoomId, ShortId } from './domain.js';
import type { Actor, HistoryPort, RetrievalPort } from './ports.js';
import { swedishTerms } from './swedish.js';

export const DEFAULT_CHANGES_LIMIT = 5;

/**
 * How many history entries to scan per room when looking for a chain by its old wording.
 *
 * Same interim shape, and the same bound, as `askMemory`: there is no free-text index on
 * `app.event` (build-plan decision 6), so a keyword search over the log reads a window
 * and filters it in the process. A chain whose old value fell outside the window is
 * still reachable through its current text — this arm widens what finds a chain, it is
 * not the only way in.
 */
const HISTORY_SCAN_LIMIT = 300;

/**
 * Which history actions may be used to *find* a chain by its text.
 *
 * Not an output allowlist — the bodies that come back are the chain's own values, and
 * the head check is what makes them safe to show. This is narrower than it looks: these
 * are the four actions whose payload text is a value the memory actually held.
 * `proposed` is excluded because a proposal is not something that happened, which is the
 * same reason `ask.ts` excludes it; `deleted` and `purged` are excluded because matching
 * them would be searching for text on the strength of its removal.
 */
const FINDABLE_BY_TEXT = new Set<HistoryEntry['action']>([
  'saved',
  'updated',
  'superseded',
  'restored',
]);

export interface ChangesInput {
  /** Free text. What the person is asking about, in their words, old or current. */
  query?: string;
  roomIds?: RoomId[];
  /**
   * Bounds on *when a change happened*, not on when the memory was created.
   *
   * A chain is kept when at least one of its steps falls inside the window, and it is
   * then shown **in full** — including steps from before `since`. That is the point of
   * the question: "vad ändrades den här veckan" is answered by the change *and* by what
   * it changed from, and cutting the chain at the window boundary would leave the answer
   * as "it changed" with no way to see to what.
   */
  since?: Date;
  until?: Date;
  limit?: number;
}

export interface ChangesServices {
  retrieval: Pick<RetrievalPort, 'search'>;
  history: Pick<HistoryPort, 'list' | 'changes'>;
}

export async function memoryChanges(
  services: ChangesServices,
  actor: Actor,
  input: ChangesInput,
): Promise<MemoryChange[]> {
  const query = input.query?.trim() || undefined;
  const limit = input.limit ?? DEFAULT_CHANGES_LIMIT;
  const windowed = Boolean(input.since || input.until);

  // Without either a query or a window there is no question here. Returning "every
  // memory that has ever changed" would be a dump, not an answer.
  if (!query && !windowed) return [];

  const candidates = new Set<ShortId>();

  for (const shortId of await currentTextMatches(services, actor, input, query, limit)) {
    candidates.add(shortId);
  }
  for (const shortId of await pastTextMatches(services, actor, input, query)) {
    candidates.add(shortId);
  }

  if (candidates.size === 0) return [];

  // Over-fetched: the window filter and the head check below both remove chains after
  // the fact, and the final slice still lands on `limit`.
  const chains = await services.history.changes(actor, [...candidates], { limit: limit * 3 });

  return dropDeletedHeads(chains)
    .filter((chain) => changedInsideWindow(chain, input))
    .filter((chain) => (input.roomIds?.length ? input.roomIds.includes(chain.roomId) : true))
    .sort((a, b) => b.lastChangedAt.getTime() - a.lastChangedAt.getTime())
    .slice(0, limit);
}

/**
 * The second, independent refusal of a chain whose memory is gone.
 *
 * `HistoryPort.changes` already will not return one — this is not a substitute for that
 * and neither is a substitute for this. The two implementations of the port are 1400
 * lines each and get rewritten; this function is four lines and is the one place a unit
 * test can pin the rule without a database. A leak that has been closed twice gets two
 * locks.
 *
 * `currentBody` is typed non-null precisely so that a chain arriving with nothing at the
 * end of it is a shape error rather than an empty string quietly rendering.
 */
function dropDeletedHeads(chains: MemoryChange[]): MemoryChange[] {
  return chains.filter((chain) => Boolean(chain.currentBody && chain.currentBody.trim()));
}

function changedInsideWindow(chain: MemoryChange, input: ChangesInput): boolean {
  if (!input.since && !input.until) return true;

  return chain.steps.some((step) => {
    const at = step.at.getTime();
    if (input.since && at < input.since.getTime()) return false;
    if (input.until && at > input.until.getTime()) return false;
    return true;
  });
}

/** Chains reachable from what the memory says *now*. */
async function currentTextMatches(
  services: ChangesServices,
  actor: Actor,
  input: ChangesInput,
  query: string | undefined,
  limit: number,
): Promise<ShortId[]> {
  if (!query) return [];

  const hits = await services.retrieval.search(actor, {
    query,
    ...(input.roomIds?.length ? { roomIds: input.roomIds } : {}),
    limit: limit * 3,
  });

  // Items only. A document chunk has no supersede chain and no short id to resolve one
  // by — document versioning is a different feature and pretending otherwise here would
  // return an empty chain per chunk.
  return hits
    .filter((hit) => hit.kind === 'item' && hit.shortId)
    .map((hit) => hit.shortId as ShortId);
}

/**
 * Chains reachable from what the memory *used to* say.
 *
 * This is the arm that makes the feature answer the question as people ask it. Somebody
 * asking how their address changed says "Stockholm", which is the value that is gone —
 * and `RetrievalPort.search` cannot find it, because a superseded item is excluded from
 * search by design and an updated one no longer contains the words.
 *
 * A short id found here may well be a superseded item's, which is fine and intended:
 * `HistoryPort.changes` resolves any id in a chain to the chain.
 */
async function pastTextMatches(
  services: ChangesServices,
  actor: Actor,
  input: ChangesInput,
  query: string | undefined,
): Promise<ShortId[]> {
  if (!query) {
    // No query, but a window: every chain that changed inside it. The room fan-out is
    // the same as `askMemory`'s, and the window filter runs on the assembled chains.
    return (await scanHistory(services, actor, input))
      .filter((entry) => entry.shortId)
      .map((entry) => entry.shortId as ShortId);
  }

  const wanted = new Set(swedishTerms(query));
  if (wanted.size === 0) return [];

  return (await scanHistory(services, actor, input))
    .filter((entry) => entry.shortId && FINDABLE_BY_TEXT.has(entry.action))
    .filter((entry) => {
      // The same stemmed-term overlap the lexical arms of search use, through the one
      // shared Swedish module — so "adressen" finds "adress" here exactly as it does
      // there, rather than this arm having its own idea of what a word is.
      const terms = swedishTerms(entry.body ?? '');
      return terms.some((term) => wanted.has(term));
    })
    .map((entry) => entry.shortId as ShortId);
}

async function scanHistory(
  services: ChangesServices,
  actor: Actor,
  input: ChangesInput,
): Promise<HistoryEntry[]> {
  const rooms = input.roomIds?.length ? input.roomIds : [undefined];
  const collected: HistoryEntry[] = [];

  for (const roomId of rooms) {
    const entries = await services.history.list(actor, {
      ...(roomId ? { roomId } : {}),
      ...(input.since ? { since: input.since } : {}),
      limit: HISTORY_SCAN_LIMIT,
    });
    collected.push(...entries);
  }

  return input.until
    ? collected.filter((entry) => entry.occurredAt.getTime() <= input.until!.getTime())
    : collected;
}
