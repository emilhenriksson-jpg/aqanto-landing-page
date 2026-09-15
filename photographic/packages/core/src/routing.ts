/**
 * Automatic memory routing: where does this belong, and why there.
 *
 * Section 6 of the scope asks the system to decide what is worth saving, where it
 * belongs, whether it is new, and whether it replaces something. The middle question was
 * the one still being answered by the caller: a write with no room named defaulted to the
 * personal room, silently, so "Photographic decides where it goes" was really "the client
 * decides, and the client always says private".
 *
 * This decides. Three properties hold by construction rather than by care, because each
 * of them is a failure that would be discovered late and be unrecoverable.
 *
 * **Nothing is auto-shared.** The router picks a target; it does not decide whether the
 * write lands. Any target other than the personal room reaches `requiresApproval` exactly
 * as a hand-named room would, and that gate refuses every write into a shared room. So
 * the worst a wrong routing decision can do is put a question in the approval queue.
 * There is deliberately no path here that returns "and no approval needed".
 *
 * **Uncertainty resolves towards private, never towards a guess.** A weak best match, or
 * two rooms matching about equally, both mean private. Not because private is a neutral
 * default but because it is the reversible one: a memory that should have been in a room
 * can be moved in one action, and a memory that should not have been in front of four
 * colleagues cannot be taken back out of their heads.
 *
 * **The model may only ever make the outcome more private.** The shortlist is computed
 * from text, deterministically. A model — which reads content we did not write, including
 * documents — can veto a candidate but can never propose one. That is the same asymmetry
 * as the `explicit` fix in `requiresApproval`: untrusted input is allowed to tighten a
 * decision and never to loosen it. It is also what makes the feature behave identically
 * whether the model is real, fake, or unreachable.
 */

import type { Actor, LlmPort } from './ports.js';
import type { ItemKind, RoomId, RoomKind } from './domain.js';
import { NotPermittedError } from './errors.js';
import {
  ROUTING_MIN_MARGIN,
  ROUTING_MIN_SCORE,
  dedupeHash,
} from './policy.js';
import { swedishStem } from './swedish.js';

/** A room the router may consider, and enough about it to tell what it is for. */
export interface RoutingCandidate {
  roomId: RoomId;
  kind: RoomKind;
  title: string;
  /** The room in one sentence, as the overview shows it. May be empty. */
  headline: string;
  /** Active members including the person. `1` means nobody else can read it. */
  memberCount: number;
  /** A few of the room's own memories, which is what it is actually about. */
  sample: string[];
}

export interface RoutingDeps {
  /** Rooms the actor may write to, personal room included. */
  candidates(actor: Actor): Promise<RoutingCandidate[]>;
  /**
   * Optional narrowing only.
   *
   * Absent — the deterministic fake, an unconfigured process, a provider outage — leaves
   * the lexical decision standing. That is why it is optional rather than required: a
   * routing layer that stops working when the model does is a routing layer nobody can
   * rely on, and one that only works with a real model is invisible in the environment
   * everything is tested in.
   */
  llm?: Pick<LlmPort, 'confirmPlacement'>;
}

export type RoutingPlacement = 'private' | 'room';

export interface RoutingDecision {
  roomId: RoomId;
  placement: RoutingPlacement;
  roomTitle: string;
  /**
   * Swedish, written for a person, recorded on the event at decision time.
   *
   * Recorded rather than reconstructed, because reconstructing why something was placed
   * somewhere — months later, from a room list that has since changed — is guessing, and
   * a guess presented as an explanation is worse than no explanation.
   */
  motivation: string;
  /** Why this was not a clear call, when it was not. Becomes the proposal's reason. */
  uncertainty: string | null;
  /** True when the target is a room other people can read. Informational. */
  reachesOtherPeople: boolean;
  /** What was considered, strongest first, so a decision can be shown to be non-arbitrary. */
  considered: Array<{ roomId: RoomId; title: string; score: number }>;
}

/**
 * Words that carry no subject matter.
 *
 * Not a stop list for search — a short list of the connectives long enough to survive the
 * length filter. They matter because the score is a fraction of the memory's own words:
 * "skjuts till Q3 enligt ledningen" is three words about a subject and two that are not,
 * and counting all five caps the best possible match at sixty per cent.
 */
const FUNCTION_WORDS = new Set([
  'till', 'fran', 'efter', 'innan', 'under', 'over', 'eller', 'samt', 'ocksa',
  'enligt', 'sedan', 'medan', 'genom', 'utan', 'inom', 'mellan', 'denna', 'detta',
  'dessa', 'deras', 'vilket', 'vilka', 'blir', 'blev', 'vara', 'varit', 'hade',
  'skulle', 'kunna', 'maste', 'igang', 'drar', 'bokar', 'ratt',
  'with', 'from', 'that', 'this', 'have', 'been', 'will', 'about', 'into',
]);

/**
 * Words worth matching on.
 *
 * Short tokens carry no subject matter and Swedish is full of them.
 */
function terms(text: string): Set<string> {
  return new Set(wordsByStem(text).keys());
}

/**
 * Stems mapped back to the word they came from.
 *
 * Inflection is handled by `swedishStem` — the shared Snowball implementation in
 * `swedish.ts`, the same one the lexical arms of search use and the same algorithm
 * behind Postgres's `to_tsvector('swedish', …)`. This file used to carry its own
 * eleven-suffix list with a note saying to replace it rather than grow it, precisely so
 * a second hand-rolled Swedish suffix list would not take root; that list is now gone
 * and there is one. It matters beyond tidiness: a room's own memories are ranked by
 * search and matched by this router, and two different ideas of what "ledningen" reduces
 * to means the router files a memory somewhere search will then rank differently.
 *
 * Tokenisation matches `swedishTerms` (anything that is not a letter or digit splits),
 * so "due diligence-paketet" breaks the way a person would expect. Two things stay local
 * because they are the router's own policy rather than the language's:
 *
 *  - `dedupeHash` still folds accents and case for the length and function-word filters,
 *    because `FUNCTION_WORDS` is written accent-stripped and because a three-letter token
 *    carries no subject matter whatever its diacritics. Stemming itself runs on the
 *    accented word, so the router's stems are the same strings search produces.
 *  - Matching happens on stems and explaining happens in words. Telling a person their
 *    memory was filed somewhere "eftersom det nämner forvarv" shows them the inside of
 *    the matcher when the promise was a sentence phrased for them. The first spelling
 *    wins, so the explanation quotes the memory as they wrote it.
 */
function wordsByStem(text: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;

    const folded = dedupeHash(raw);
    if (folded.length <= 3 || FUNCTION_WORDS.has(folded)) continue;

    const key = swedishStem(raw);
    if (key && !out.has(key)) out.set(key, raw);
  }

  return out;
}

/**
 * How much of this memory's subject matter the room accounts for.
 *
 * Measured against the memory rather than against the room: a room with two hundred
 * memories should not out-score a focused one just by being large. Title and headline
 * count for more than a single stored memory, because they are what the room *is* rather
 * than one thing that happened in it.
 */
function score(candidate: RoutingCandidate, wanted: Set<string>): number {
  if (wanted.size === 0) return 0;

  const weighted = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const term of terms(text)) {
      weighted.set(term, Math.max(weighted.get(term) ?? 0, weight));
    }
  };

  add(candidate.title, 1);
  add(candidate.headline, 0.8);
  for (const memory of candidate.sample) add(memory, 0.5);

  let matched = 0;
  for (const term of wanted) matched += weighted.get(term) ?? 0;

  return matched / wanted.size;
}

/**
 * Decides where a memory goes when nobody named a room.
 *
 * Never throws on a model failure and never returns a target it has not checked the actor
 * can write to — `candidates` is the caller's list of rooms the actor may write to, so the
 * scope of what the router can even consider is decided before it runs.
 */
export async function routeMemory(
  deps: RoutingDeps,
  actor: Actor,
  input: { body: string; kind?: ItemKind },
): Promise<RoutingDecision> {
  /**
   * A narrowed token narrows routing too.
   *
   * Membership is not the only fence: a token may be issued for a subset of a person's
   * rooms, and `assertRoomInScope` enforces that on every path where a room is *named*.
   * Routing is the path where no room is named, so the same rule has to be applied here
   * or automatic placement becomes the way around it — a token issued for one room could
   * write to the personal room simply by not mentioning it.
   */
  const candidates = (await deps.candidates(actor)).filter(
    (room) => actor.roomScope.length === 0 || actor.roomScope.includes(room.roomId),
  );
  const personal = candidates.find((room) => room.kind === 'personal');

  // Without a reachable personal room there is nowhere safe to fall back to, and inventing
  // a fallback into someone else's room is the one thing this file exists to prevent.
  // Refused as not-permitted, which the API renders as a 404 like every other denial.
  if (!personal) {
    throw new NotPermittedError(
      'Det finns ingen plats att spara det här på. Ange ett rum du har åtkomst till.',
    );
  }

  const wanted = terms(input.body);
  const ranked = candidates
    .filter((room) => room.kind !== 'personal')
    .map((room) => ({ room, value: score(room, wanted) }))
    .sort((a, b) => b.value - a.value);

  const considered = ranked.map(({ room, value }) => ({
    roomId: room.roomId,
    title: room.title,
    score: Number(value.toFixed(3)),
  }));

  const best = ranked[0];
  const runnerUp = ranked[1];

  /**
   * Instructions and negative constraints are never routed.
   *
   * They describe how the person wants every model they use to behave, which is a fact
   * about them and not about any room's subject matter. A room is the wrong place for one
   * even when the words happen to overlap.
   */
  if (input.kind === 'instruction' || input.kind === 'never') {
    return privately(personal, considered, 'Styr hur dina AI:er svarar, så det hör hemma i ditt privata minne.');
  }

  if (!best || best.value < ROUTING_MIN_SCORE) {
    return privately(personal, considered, null);
  }

  // Two rooms matching about equally is a question, not a close call to settle by
  // arithmetic. Private, and the person can move it in one action if we chose wrong.
  if (runnerUp && best.value - runnerUp.value < ROUTING_MIN_MARGIN) {
    return privately(
      personal,
      considered,
      `Kunde höra hemma i både ${best.room.title} och ${runnerUp.room.title}, så det sparas privat tills du säger annat.`,
    );
  }

  // The model's only move: veto. It cannot promote a room onto the shortlist, so a
  // compromised or unavailable one cannot cause a disclosure — only prevent one.
  const vetoed = await vetoOf(deps, input.body, best.room);
  if (vetoed) {
    return privately(personal, considered, vetoed);
  }

  const shared = best.room.memberCount > 1;
  const inRoom = terms([best.room.title, best.room.headline, ...best.room.sample].join(' '));
  const spelled = wordsByStem(input.body);
  const overlap = [...wanted]
    .filter((term) => inRoom.has(term))
    .map((term) => spelled.get(term) ?? term);

  return {
    roomId: best.room.roomId,
    placement: 'room',
    roomTitle: best.room.title,
    motivation: roomMotivation(best.room.title, overlap),
    // Never null for a room: even a confident placement into a room other people read is
    // something a person should be asked about, and this is the sentence they are asked with.
    uncertainty: shared
      ? `Hör till ${best.room.title}, men rummet läses av andra — därför frågar vi först.`
      : `Hör till ${best.room.title}.`,
    reachesOtherPeople: shared,
    considered,
  };
}

function privately(
  personal: RoutingCandidate,
  considered: RoutingDecision['considered'],
  uncertainty: string | null,
): RoutingDecision {
  return {
    roomId: personal.roomId,
    placement: 'private',
    roomTitle: personal.title,
    motivation: uncertainty ?? 'Sparat privat eftersom det handlar om dig.',
    uncertainty,
    reachesOtherPeople: false,
    considered,
  };
}

/**
 * Names the overlap, because "hör till Villan" is an assertion and "hör till Villan
 * eftersom det nämner köket" is a reason. A person who disagrees can see what we matched
 * on, which is the difference between an explanation and a verdict.
 */
function roomMotivation(roomTitle: string, overlap: string[]): string {
  const words = overlap.slice(0, 3);
  if (words.length === 0) return `Hör till ${roomTitle} snarare än till ditt privata minne.`;
  return `Hör till ${roomTitle} eftersom det nämner ${words.join(', ')}.`;
}

/** A model failure is not a routing failure: an unreachable veto is simply no veto. */
async function vetoOf(
  deps: RoutingDeps,
  body: string,
  room: RoutingCandidate,
): Promise<string | null> {
  if (!deps.llm?.confirmPlacement) return null;

  try {
    const verdict = await deps.llm.confirmPlacement({
      text: body,
      roomTitle: room.title,
      roomHeadline: room.headline,
    });
    if (verdict.belongs) return null;

    return verdict.because?.trim()
      ? `Sparat privat: ${verdict.because.trim()}`
      : `Orden liknade ${room.title}, men innehållet hör inte dit. Sparat privat.`;
  } catch {
    // Deliberately swallowed. The lexical decision already stands on its own, and a
    // provider outage must not turn into either an error the person sees or a different
    // placement than they would have got an hour earlier.
    return null;
  }
}

/**
 * The placement sentence and the approval sentence, as one thing a person reads.
 *
 * They answer different questions — why this room, and why we are asking — and a person
 * clearing the queue needs both. The gate's reasons are written as lowercase fragments
 * because they are appended to other text elsewhere, so joining them naively produces
 * "Hör till Buyersclub Ledning. delade rum ändras bara…".
 */
export function joinReason(placement: string | null | undefined, gate: string): string {
  if (!placement) return gate;
  const sentence = gate.charAt(0).toUpperCase() + gate.slice(1);
  return `${placement} ${sentence}.`;
}
