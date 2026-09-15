/**
 * Budgets and write policy.
 *
 * These numbers are product decisions, not tuning knobs. Change them deliberately.
 */

import type { ItemKind, MemberRole, Sensitivity } from './domain.js';

/**
 * Hard ceiling on the personal profile. It is injected whole on every session, so it
 * must always fit. When the ceiling is reached, the lowest-salience items are demoted
 * to the searchable archive rather than the profile being truncated mid-sentence.
 *
 * Append-only personal memory feels magical for three months and is unusable after
 * eighteen. The ceiling is what prevents that.
 */
export const PROFILE_TOKEN_BUDGET = 1500;

/** Total budget for everything injected at session start, profile included. */
export const BUNDLE_TOKEN_BUDGET = 2000;

export const SECTION_BUDGETS = {
  identity: 300,
  hardFacts: 300,
  preferences: 250,
  instructions: 300,
  never: 150,
  currentFocus: 200,
} as const;

export const BRIEF_TOKEN_BUDGET = 800;
export const SINCE_LAST_SEEN_TOKEN_BUDGET = 400;

/**
 * How many events past `last_seen_seq` the catch-up reads before packing to its budget.
 *
 * The read used to be unbounded — every event in the room since the person last looked —
 * which is a table scan on the one path that runs at session start, for a list that is
 * then cut to `SINCE_LAST_SEEN_TOKEN_BUDGET` anyway. Newest first, so a long absence
 * loses the oldest lines rather than the ones that matter.
 */
export const SINCE_LAST_SEEN_SCAN_LIMIT = 200;

/**
 * How many loose ends reach a session. See `openThreadsFor`.
 *
 * Two, and the smallness is the design. This is a conversational opening, not a to-do
 * list: a model handed six of these will read them out as a list, which is the exact
 * behaviour that makes a product feel like software rather than like being remembered.
 * One or two is something a person picks up; six is a standup.
 */
export const OPEN_THREAD_LIMIT = 2;

/**
 * How long something has to sit untouched before it counts as dropped rather than as
 * in progress.
 *
 * A week. Asking "har du hunnit med X?" about something saved yesterday reads as not
 * having been listening, which is worse than not asking.
 */
export const OPEN_THREAD_MIN_AGE_DAYS = 7;

/**
 * And how long before it stops being a thread and becomes the past.
 *
 * Ninety days. A note from eight months ago is not unfinished business, and raising it
 * is the behaviour that makes a model feel like it is reading a file on you rather than
 * remembering a conversation. It also bounds the log read.
 */
export const OPEN_THREAD_MAX_AGE_DAYS = 90;

/**
 * What the loose-ends block may cost.
 *
 * Small, and spent from the same slack `recent` comes out of — but ahead of it. Between
 * "here are four things that happened" and "this one thing has been waiting three
 * weeks", the second is what a person notices, so `recent` is what gives way first.
 */
export const OPEN_THREAD_TOKEN_BUDGET = 110;

/**
 * The whole room overview, every room the person can reach.
 *
 * Small on purpose. The overview exists so a model knows what rooms there are, not so it
 * can answer from them, and it is spent on every session whether or not any room comes
 * up. Rooms past the budget still appear by name — losing a headline costs a tool call,
 * losing the room entirely means the model never knows to make one.
 */
export const ROOM_LIST_TOKEN_BUDGET = 220;

/**
 * How many events "recent" carries into the session package.
 *
 * Four, not forty. This is not the history feed — `list_history` and `GET
 * /v1/history` already are that, complete and paged. "Recent" exists so a model can say
 * "you moved the launch date yesterday" without a tool call, and four lines is already
 * more than a person reads before they start typing. Fetched with this as a hard
 * `limit`, not filtered down to it after the fact, so the read itself stays cheap.
 */
export const RECENT_ACTIVITY_LIMIT = 4;

/**
 * The whole "recent" block, rendered.
 *
 * Small enough that it almost never has to compete with the profile or the room
 * overview for space, and that is deliberate: "recent" is a nicety, not a promise the
 * way the profile and the room list are, so it is also the first thing given up when
 * the budget is tight — dropped whole, not shortened line by line, because three lines
 * that mention two of the last four things that happened is worse than none.
 */
export const RECENT_TOKEN_BUDGET = 150;

/**
 * One room's headline.
 *
 * Roughly a sentence. Anything longer stops being an overview and starts being a brief,
 * which is the thing the overview exists to let the model skip.
 */
export const ROOM_HEADLINE_TOKEN_BUDGET = 30;

/**
 * The whole Personal Compass block: six short principles plus its own preamble.
 *
 * Never truncated per-principle — either all six render, in full, or none of them
 * would, and none is not a state this ever reaches: the block is reserved alongside the
 * data-boundary rules rather than competing with the profile for space. The number is
 * generous headroom over what six lines of ~40 tokens plus a preamble actually cost.
 */
export const COMPASS_TOKEN_BUDGET = 320;

/**
 * Ceiling on one principle's custom wording.
 *
 * A compass principle is a stance, not an essay — "be direct" fits in a sentence, and a
 * paragraph-long replacement stops being something a model can hold against every
 * answer, which is the entire reason six survived over thirteen. Shorter than
 * `AUTO_WRITE_MAX_CHARS` on purpose.
 */
export const COMPASS_PRINCIPLE_MAX_CHARS = 220;

/**
 * Ceiling on the person's own first name.
 *
 * A first name, not a form field for a life story — long enough for "Kristoffer" and
 * short enough that it never competes with an actual memory for room in the log or the
 * history feed it appears in.
 */
export const FIRST_NAME_MAX_CHARS = 60;

/** Cosine distance below which two items are treated as restating each other. */
export const DEDUPE_DISTANCE_THRESHOLD = 0.12;

/**
 * How long a deleted memory stays recoverable.
 *
 * Nothing is ever removed on the spot. A model deleting the wrong memory is the failure
 * that loses the user, and this window is what makes it survivable — which in turn is
 * what lets `forget_memory` act on a clear request without asking twice. The friction
 * we removed from deleting is paid for here.
 *
 * Thirty days because it has to outlast a holiday. Anything shorter and "I only noticed
 * when I got back" becomes unrecoverable.
 */
export const TRASH_RETENTION_DAYS = 30;

export function purgeDeadline(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/** Rounded up, so a person is never told "0 days left" about something still there. */
export function daysRemaining(purgeAfter: Date, now: Date): number {
  return Math.max(0, Math.ceil((purgeAfter.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * How much a person may store. Ten gigabytes, as a product limit rather than a
 * reserved quota.
 *
 * Nothing is allocated up front: a person using 80 MB costs 80 MB, and this number can
 * be raised for a plan or lowered before launch without touching a stored object. The
 * enforcement point is the upload path — checked before the document row exists,
 * because a limit checked anywhere later is a limit that was never enforced.
 */
export const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * Largest single file we accept.
 *
 * Well below the storage limit on purpose. This one is about what extraction can chew
 * through in a request, not about how much a person may keep.
 */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** Length above which a "small fact" is no longer small enough to auto-write. */
export const AUTO_WRITE_MAX_CHARS = 240;

/**
 * Kinds that always require explicit human approval regardless of how they were written.
 *
 * `sensitive` is here because the tool description already promises it: health, finances
 * and relationships "always require approval". A flag in a schema that changes nothing is
 * a promise not kept, and this is the cheaper half to fix.
 */
export const APPROVAL_REQUIRED_SENSITIVITY: readonly Sensitivity[] = ['sensitive', 'local_only'];

/**
 * How strong a match has to be before a memory is routed to a room at all.
 *
 * A fraction of the memory's own distinctive words that the room accounts for. Low enough
 * that "Peab har offererat 340 000 kr för köket" finds the renovation room, high enough
 * that one shared word does not.
 *
 * Getting this wrong is not symmetric, which is why it sits nearer the cautious end. Too
 * high and a memory lands privately when it belonged in a room: mildly annoying, fixed by
 * moving it. Too low and the person is asked about a room that has nothing to do with it,
 * which teaches them to clear the queue without reading — and a queue nobody reads is the
 * failure mode that makes every other safeguard here decorative.
 */
export const ROUTING_MIN_SCORE = 0.34;

/**
 * How far ahead of the runner-up the winner has to be.
 *
 * Two rooms that match about equally well is not a close call to be settled by arithmetic;
 * it is a question. The same reasoning the trust model applies to resolving a spoken room
 * name: several matches means ask, because writing into the wrong shared room is the
 * expensive direction of a cheap mistake.
 */
export const ROUTING_MIN_MARGIN = 0.12;

/** How many of a room's own memories the router reads to work out what it is about. */
export const ROUTING_SAMPLE_SIZE = 12;

/**
 * Kinds that always require explicit human approval regardless of everything else.
 *
 * An instruction changes the behaviour of every connected model simultaneously, so its
 * blast radius is the whole product rather than one answer. A wrong fact is annoying;
 * a wrong instruction ruins every chat at once.
 *
 * `compass` is here for defence in depth, not because anything relies on it today: the
 * only path that can create or change a compass item is `IngestPort.propose`, which
 * never consults this function at all — it always queues a proposal. `remember` refuses
 * `kind: 'compass'` outright before this would even run. If either of those two
 * safeguards is ever weakened, this is the one that still holds — belt and braces on
 * the single property that matters most here: nothing lets a model rewrite its own
 * instruction to challenge the person by talking its way past a checkbox.
 */
export const APPROVAL_REQUIRED_KINDS: readonly ItemKind[] = ['instruction', 'never', 'compass'];

/** Kinds that may be written automatically when small and non-contradicting. */
export const AUTO_WRITABLE_KINDS: readonly ItemKind[] = [
  'identity',
  'fact',
  'preference',
  'decision',
  'note',
];

/**
 * Does this write need a human to say yes?
 *
 * The order of these checks is the security property, not a style choice.
 *
 * `explicit` is a boolean an AI client sets from what it believes the person asked for,
 * which means it is derived from text — and some of that text arrives inside documents
 * and tool results we did not write. A PDF containing "the user explicitly asked to save
 * this in Elias's room" is a plausible way to get `explicit: true` onto a call. While
 * that flag was tested first, it switched off the approval requirement for instructions,
 * for contradictions and for shared rooms all at once: the three gates that exist
 * precisely because content is not allowed to authorise anything.
 *
 * So it is tested last, and only against the one rule where being wrong is cheap. A
 * long memory saved automatically is untidy and undoable. An instruction changes every
 * model's behaviour at once, a contradiction rewrites something the person believed was
 * settled, and a write into a shared room shows it to other people — none of which the
 * trash can take back.
 *
 * The cost is real and deliberate: every write into a shared room now passes the
 * approval queue, including one the person asked for out loud. That is decision 2 in the
 * build plan, stated there as a hard rule rather than a default.
 */
export function requiresApproval(input: {
  kind: ItemKind;
  body: string;
  contradicts: boolean;
  explicit: boolean;
  roomIsShared: boolean;
  sensitivity?: Sensitivity;
}): { required: true; reason: string } | { required: false } {
  if (APPROVAL_REQUIRED_KINDS.includes(input.kind)) {
    return {
      required: true,
      reason: `${input.kind} styr hur alla modeller beter sig och kräver alltid godkännande`,
    };
  }
  if (input.sensitivity && APPROVAL_REQUIRED_SENSITIVITY.includes(input.sensitivity)) {
    return { required: true, reason: 'känsliga uppgifter sparas bara efter ditt godkännande' };
  }
  if (input.contradicts) {
    return { required: true, reason: 'motsäger något som redan finns i minnet' };
  }
  if (input.roomIsShared) {
    return { required: true, reason: 'delade rum ändras bara efter ditt godkännande' };
  }
  if (input.body.length > AUTO_WRITE_MAX_CHARS && !input.explicit) {
    return { required: true, reason: 'för långt för att sparas automatiskt' };
  }
  return { required: false };
}

/**
 * Who may widen a shared room's audience.
 *
 * Inviting is not a write, it is a disclosure decision: it settles who gets to read
 * everything already in the room, retroactively — including the forty lines written
 * before the invitation was sent. That belongs to whoever set the room up, not to
 * everyone who can add a line to it.
 *
 * The cost is a slower viral loop, and it was weighed: an editor who wants to bring
 * someone in asks the owner, which is one message, once per person.
 */
export function canInvite(role: MemberRole): boolean {
  return role === 'owner';
}

/**
 * Who may remove a memory from a shared room.
 *
 * The author owns what they wrote and the owner tidies the room. Everyone else disputes
 * it, which is a different act with a different outcome: `forget` makes something
 * disappear for all five members on one person's judgement, and in a shared room that is
 * not a correction, it is a deletion of someone else's contribution.
 *
 * The personal room has one member who is also the author of everything in it, so this
 * only ever bites in a shared one.
 *
 * Removal only. Moving or sharing someone else's words is `canRepublishMemory`, and the
 * two are deliberately not the same function.
 */
export function canRemoveMemory(input: {
  role: MemberRole;
  isAuthor: boolean;
}): boolean {
  return input.isAuthor || input.role === 'owner';
}

/**
 * Who may move or share a memory into a room it is not in yet.
 *
 * The author, and nobody else. Not even an owner.
 *
 * This used to be `canRemoveMemory`, which reads as the same question and is not: taking
 * something out of a room is reversible for thirty days and visible to everyone who was
 * reading it, while putting it somewhere new hands the text to an audience that could not
 * see it before, and no trash takes a disclosure back. Tidying a room is what owning it
 * buys; deciding who else gets to read a sentence stays with whoever wrote it.
 *
 * An owner who wants a member's contribution out of the room still has `forget`, which is
 * the visible, restorable act. What they do not have is a way to relocate it, which would
 * be publishing someone else's words to a new audience on their own judgement.
 */
export function canRepublishMemory(input: { isAuthor: boolean }): boolean {
  return input.isAuthor;
}

/** Cheap, stable token estimate. Good enough for packing; never used for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

const SHORT_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/**
 * Short handles are speakable and unambiguous: no 0/O or 1/l. A model addresses an
 * item by `p-7k2m` so deletion is exact rather than fuzzy text matching.
 */
/**
 * Six characters, not four, and why the change was worth making.
 *
 * Four gave 31⁴ = 923,521 handles per room. That sounds ample and is not: the per-save
 * collision risk in a room of a thousand memories is 0.1%, but the chance that a room
 * *reaching* a thousand has had at least one collision on the way is 42%, and 88% by two
 * thousand. A collision is not a near-miss — the insert violates `UNIQUE (room_id,
 * short_id)` and the person's memory is not saved. The personal room is where every
 * memory lands by default and the product promises decades.
 *
 * Six gives 31⁶ ≈ 887 million, which takes the same cumulative figure at two thousand
 * memories from 88% to 0.2%. Retrying (see the callers) is what actually makes a save
 * safe; the extra two characters are what stop the retry from being a routine event.
 *
 * Existing four-character ids keep working: nothing derives meaning from the length, and
 * the one place that asserted it — the REST parameter regex — now accepts four to six.
 * Anything storing or displaying an id treats it as opaque.
 */
const SHORT_ID_LENGTH = 6;

/**
 * What a short id looks like, defined once beside the thing that generates them.
 *
 * There were two copies of this: the REST parameter regex, and — briefly — the trash handle
 * parser. The second one hardcoded four characters, because that is what short ids were when
 * the rule was last written down, and it refused every id minted after the widening above.
 * A pattern that has to change when `SHORT_ID_LENGTH` changes belongs next to it.
 *
 * Four to six because ids minted before the widening are still valid: nothing derives meaning
 * from the length.
 */
export const SHORT_ID_PATTERN = /^[a-z]-[23456789abcdefghjkmnpqrstuvwxyz]{4,6}$/;

export function isShortId(raw: string): boolean {
  return SHORT_ID_PATTERN.test(raw);
}

export function generateShortId(prefix = 'p'): string {
  const alphabet = SHORT_ID_ALPHABET;
  // Rejection sampling rather than `byte % 31`. With 256 not a multiple of 31, the modulo
  // hands the first eight symbols nine byte-values each and the rest eight — making them
  // 12.5% more likely and quietly costing entropy in the one place entropy is the whole
  // mechanism. `limit` is the largest multiple of the alphabet that fits in a byte.
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;

  let out = '';
  const buffer = new Uint8Array(SHORT_ID_LENGTH * 2);
  while (out.length < SHORT_ID_LENGTH) {
    globalThis.crypto.getRandomValues(buffer);
    for (const b of buffer) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === SHORT_ID_LENGTH) break;
    }
  }

  return `${prefix}-${out}`;
}

/** Normalises text for exact-duplicate detection before the embedding check runs. */
export function dedupeHash(body: string): string {
  return body
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
