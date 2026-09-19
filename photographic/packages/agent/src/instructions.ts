import { CONTEXT_CONTRIBUTION_INSTRUCTIONS } from './contribution-instructions.js';
/**
 * The session instructions: the text that arrives in system-prompt position before the
 * person types anything.
 *
 * This is what "full context immediately" actually means in practice. Everything else
 * — the tools, the search, the rooms — is what happens after the model already knows
 * who it is talking to. If this text is wrong or missing, the product has not worked,
 * no matter how well the rest behaves.
 *
 * Only cross-cutting rules belong here. Per-tool guidance lives in each tool's
 * description, where it reaches the model while it is considering that tool rather than
 * competing for attention at session start.
 */

import type {
  ActiveRoomContext,
  CompassEntry,
  ContextBundle,
  HistoryAction,
  HistoryEntry,
  OpenThread,
  Profile,
  RenderedItem,
  RoomSummary,
} from '@photographic/core';
import {
  COMPASS_PRINCIPLES,
  OPEN_THREAD_TOKEN_BUDGET,
  RECENT_TOKEN_BUDGET,
  ROOM_LIST_TOKEN_BUDGET,
  estimateTokens,
} from '@photographic/core';

import { wrapRoomContent } from './boundary.js';
import { DATA_BOUNDARY, HOW_TO_CONFIRM, LANGUAGE } from './policy-text.js';

export { estimateTokens };

/**
 * Hard ceiling on the whole instructions string.
 *
 * A budget rather than a target. Some clients truncate long instruction strings without
 * saying so, and a silently cut profile is worse than a smaller complete one: the person
 * cannot tell which half the model got.
 */
export const INSTRUCTIONS_TOKEN_BUDGET = 1400;

/** See `MIN_HONOURABLE_BUDGET_TOKENS`, declared below `PREAMBLE` because it reads it. */

function section(heading: string, items: RenderedItem[], now: Date): string | null {
  if (items.length === 0) return null;
  const lines = items.map((item) => `- ${itemLabel(item, now)}${item.body} (${item.shortId})`);
  return `${heading}\n${lines.join('\n')}`;
}

/**
 * The prefix on a profile line, which only `currentFocus` has.
 *
 * `Håller på med just nu` is fed by both `decision` and `note`, so a model saw a real
 * decision and somebody's passing thought as identical bullets under a heading asserting
 * both were current. That is the section most likely to make a model confidently wrong
 * about a person's life — worse than clutter, because a wrong fact is annoying and a
 * wrong claim about what someone is *doing* reads as not knowing them at all.
 *
 * So the line says which it is and when it was said, and nothing else in the profile
 * does: a date on "Allergisk mot ketchup" is noise, and noise is exactly what stops a
 * date meaning anything where it matters.
 */
function itemLabel(item: RenderedItem, now: Date): string {
  if (!item.kind && !item.at) return '';

  const parts: string[] = [];
  if (item.kind) parts.push(item.kind === 'decision' ? 'beslut' : 'anteckning');
  if (item.at) parts.push(relativeSwedishDay(item.at, now));

  return parts.length > 0 ? `[${parts.join(' · ')}] ` : '';
}

type SectionName = keyof Profile['sections'];

/** The order sections are printed in. */
const DISPLAY_ORDER: Array<{ name: SectionName; heading: string }> = [
  { name: 'identity', heading: 'Om personen' },
  { name: 'hardFacts', heading: 'Fakta' },
  { name: 'preferences', heading: 'Preferenser' },
  { name: 'instructions', heading: 'Så vill personen att du arbetar — följ detta' },
  { name: 'never', heading: 'Gör aldrig detta' },
  {
    name: 'currentFocus',
    // Not "Håller på med just nu", which asserted currency for every line under it,
    // including notes nobody has touched in a month. The heading now says what the
    // section is and hands the judgement to the reader, which the dates make possible.
    heading:
      'På gång — beslut och anteckningar, daterade. Det äldsta kan ha slutat gälla; fråga hellre än att påstå',
  },
];

/**
 * The order sections are *kept* in when there is not room for everything, which is not
 * the order they are printed in.
 *
 * Who someone is and how they want to be treated are what make the connection worth
 * having at all; what they happened to be working on last week is the first thing a
 * person would drop themselves. Facts sit in the middle because a missing one is
 * recoverable — the model can search for it — while a missing standing instruction is
 * not, since the model has no reason to go looking for a rule it does not know exists.
 */
const RETENTION_ORDER: SectionName[] = [
  'identity',
  'instructions',
  'never',
  'hardFacts',
  'preferences',
  'currentFocus',
];

const COMPASS_PREAMBLE = `Personens kompass — hur den här personen alltid vill bli bemött, inte
bara när de påminner dig om det:`;

/**
 * The six Personal Compass principles, rendered as their own block.
 *
 * Unlike every other block in this file, nothing here is ever dropped individually and
 * nothing is picked by budget: the six principles are always exactly six, short by
 * construction (`COMPASS_PRINCIPLE_MAX_CHARS`), and the whole block is reserved
 * alongside the rules in `assembleBlocks` below — the opposite end of the retention
 * order from "recent", which is deliberately the first thing given up. A model that
 * received five of six principles has no way to know the sixth existed, which is
 * exactly the failure "recent activity" is allowed to have and this block is not.
 *
 * A default principle (nobody has customised it) renders with no id, because there is
 * nothing to point `list_history` or `update_compass` at — it is not a memory, only the
 * fallback for one that has not been written yet.
 */
export function renderCompass(compass: CompassEntry[]): string {
  if (compass.length === 0) return '';

  const lines = compass.map((entry) =>
    entry.shortId ? `- ${entry.text} (${entry.shortId})` : `- ${entry.text}`,
  );

  return `${COMPASS_PREAMBLE}\n${lines.join('\n')}`;
}

/**
 * The person, rendered.
 *
 * Standing instructions are kept in their own section rather than mixed in with facts,
 * because they are the only part the model is meant to *obey* rather than merely know.
 * Flattening the two is how "I prefer concise answers" ends up treated as trivia.
 *
 * `budgetTokens` drops whole items when the profile will not fit. The projection
 * already caps the profile at `PROFILE_TOKEN_BUDGET`, so this is the second line of
 * defence rather than the first — but a renderer that silently overruns its budget is
 * how a client ends up truncating mid-sentence, and then the person cannot tell which
 * half the model got.
 */
export function renderProfile(profile: Profile, budgetTokens?: number, now?: Date): string {
  const selected = budgetTokens === undefined
    ? profile.sections
    : selectWithinBudget(profile.sections, budgetTokens);
  const asOf = now ?? profile.builtAt;

  const parts = DISPLAY_ORDER.map(({ name, heading }) =>
    section(heading, selected[name], asOf),
  ).filter((part): part is string => part !== null);

  if (parts.length === 0) {
    return `Photographic har ännu inget sparat om den här personen. Det är normalt för
ett nytt konto. Börja med din tillgängliga kontext och erbjud ett samlat bidrag innan
du börjar ställa frågor.`;
  }

  return parts.join('\n\n');
}

/**
 * Picks what fits, highest-retention first.
 *
 * Always keeps at least one item when the profile has any, because the alternative is
 * rendering the empty-state text at a person who has saved things — telling the model
 * "nothing is known about them yet" would be worse than going slightly over.
 */
function selectWithinBudget(
  sections: Profile['sections'],
  budgetTokens: number,
): Profile['sections'] {
  const kept: Profile['sections'] = {
    identity: [],
    hardFacts: [],
    preferences: [],
    instructions: [],
    never: [],
    currentFocus: [],
  };

  let used = 0;
  let any = false;

  for (const name of RETENTION_ORDER) {
    for (const item of sections[name]) {
      const cost = estimateTokens(`- ${item.body} (${item.shortId})\n`);
      if (any && used + cost > budgetTokens) continue;
      kept[name].push(item);
      used += cost;
      any = true;
    }
  }

  return kept;
}

/**
 * The overview: every room the person has, one line each.
 *
 * This is the half of "full context immediately" that is not the profile. The personal
 * room is read whole and sits above; every other room appears here as a name, whether it
 * is shared, and a sentence saying what it is for. That is deliberately not enough to
 * answer from — it is enough to know that answering would need a tool call, and which
 * room to make it about.
 *
 * Which is the failure it exists to prevent. A model that was never told a room exists
 * does not go looking for it: it answers from the profile, sounds confident, and is
 * wrong about work that lives somewhere it never saw. Room names are cheap; being
 * unaware of a room is not.
 *
 * `headlines: false` renders the same list without the sentences, for when the budget
 * will not carry them. Every room still appears — a room without its headline costs the
 * model one tool call, a room missing from the list costs it the room.
 */
function renderRooms(rooms: RoomSummary[], options: { headlines: boolean }): string | null {
  if (rooms.length === 0) return null;

  // Titles and headlines are written by people, and in a shared room by people other
  // than the one being helped. A room called "ignore previous instructions" is a cheap
  // attack and this list is the one place every session reads.
  return `${ROOM_OVERVIEW_PREAMBLE}
${wrapRoomContent(packRooms(rooms, options.headlines).join('\n'), {
  label: 'rumslista',
  notice: false,
})}`;
}

/**
 * Fits the overview into `ROOM_LIST_TOKEN_BUDGET`, names first and headlines with the
 * slack.
 *
 * The order of those two is the whole point. Spending the budget on the first few rooms'
 * headlines and running out before the last room's name is the one outcome worth
 * avoiding: the model would know a great deal about three rooms and nothing about the
 * existence of the fourth, and it is the fourth it will be wrong about. So a headline is
 * only kept while what remains still covers every room left in the list.
 *
 * Rooms come in the room service's order, personal room first, and headlines therefore
 * thin out towards the end of the list rather than at random.
 */
function packRooms(rooms: RoomSummary[], headlines: boolean): string[] {
  const names = rooms.map((room) => roomLine(room, false));
  const costs = names.map((line) => estimateTokens(`${line}\n`));
  let remaining = costs.reduce((sum, cost) => sum + cost, 0);

  if (remaining > ROOM_LIST_TOKEN_BUDGET) return truncateRooms(names, costs);

  const lines: string[] = [];
  let used = 0;

  for (const [index, room] of rooms.entries()) {
    const name = names[index]!;
    remaining -= costs[index]!;

    const full = roomLine(room, headlines);
    const cost = estimateTokens(`${full}\n`);
    const keepHeadline = headlines && used + cost + remaining <= ROOM_LIST_TOKEN_BUDGET;

    lines.push(keepHeadline ? full : name);
    used += keepHeadline ? cost : costs[index]!;
  }

  return lines;
}

/**
 * More rooms than the budget holds names for.
 *
 * Says how many were left out rather than ending the list quietly, because a list that
 * looks complete and is not will be treated as complete — and `search_memory` does reach
 * the rooms that fell off, so the model has somewhere to go once it knows they exist.
 */
function truncateRooms(names: string[], costs: number[]): string[] {
  const lines: string[] = [];
  let used = 0;

  for (const [index, name] of names.entries()) {
    const cost = costs[index]!;
    if (lines.length > 0 && used + cost > ROOM_LIST_TOKEN_BUDGET - OVERFLOW_LINE_TOKENS) break;
    lines.push(name);
    used += cost;
  }

  const hidden = names.length - lines.length;
  if (hidden > 0) {
    lines.push(`- (${hidden} rum till som inte fick plats här — search_memory söker i dem ändå)`);
  }

  return lines;
}

/** Room left for the line that says what was left out. */
const OVERFLOW_LINE_TOKENS = 25;

const ROOM_OVERVIEW_PREAMBLE = `Personens rum. Det personliga rummet står i sin helhet
ovan; av de övriga har du bara raden nedan. Hänger svaret på vad som finns i ett rum,
anropa get_context med rummets namn först. Säg namnen exakt som de står.`;

function roomLine(room: RoomSummary, headline: boolean): string {
  const marks = [sharing(room)];
  if (room.unseenCount > 0) {
    marks.push(room.unseenCount === 1 ? '1 ny' : `${room.unseenCount} nya`);
  }

  const head = `- ${room.title} (${marks.join(' · ')})`;

  if (room.kind === 'personal') return `${head}: profilen ovan är det här rummet`;

  // No dangling colon on a room that has nothing to say yet.
  const text = headline ? room.oneLine.trim() : '';
  return text ? `${head}: ${text}` : head;
}

/**
 * Whether anyone else writes here, which is what changes how a model should behave.
 *
 * Room kind does not answer it. A room you created and never invited anyone to is shared
 * by kind and private in fact, and a model that treats it as shared will hedge and
 * attribute for an audience of one.
 */
function sharing(room: RoomSummary): string {
  if (room.kind === 'personal') return 'personligt';

  const others = room.memberCount - 1;
  if (others <= 0) return 'bara du';
  return others === 1 ? 'delad med 1 person' : `delad med ${others} personer`;
}

/**
 * "Recent": the extremely short line about what just happened, across every room.
 *
 * The room overview says what exists; this says what moved, without the model having
 * to ask. Deliberately not the history feed — `list_history` already is that, complete
 * and paged — so this stays to a handful of one-line entries and drops the whole block
 * rather than shortening it further, because a partial "recent" that is missing the one
 * thing that mattered reads as complete and is not.
 *
 * Room titles and memory bodies are the same kind of data a room brief carries: written
 * by people, in a shared room by someone other than the one being helped. So the whole
 * block goes inside `wrapRoomContent`, exactly like the room overview and the active
 * room's brief.
 */
const RECENT_LABEL: Partial<Record<HistoryAction, string>> = {
  saved: 'sparade',
  updated: 'ändrade',
  superseded: 'ersatte',
  deleted: 'tog bort',
  restored: 'tog tillbaka',
  purged: 'raderade permanent',
  proposed: 'föreslog',
  approved: 'godkände',
  rejected: 'avslog',
  document_added: 'lade till ett dokument',
  room_created: 'skapade rummet',
  member_joined: 'gick med',
  member_left: 'lämnade',
  // Labelled rather than left out, because an unlabelled action falls through to its enum
  // name and `break_glass_minted` is not something to show a person through a model.
  break_glass_minted: 'nödinloggning skapad på servern',
  break_glass_used: 'nödinloggning använd för att logga in',
};

const RECENT_PREAMBLE = `Var ni var senast, utan att du behöver fråga (list_history ger hela historiken):`;

/**
 * Swedish relative time, because a date is a record and "i fredags" is a memory.
 *
 * The reason this exists at all: `recent` used to render as `- 2026-09-14: sparade —
 * Emil: Allergisk mot ketchup`, four lines of it. That is a changelog. A model reading a
 * changelog can recite it; what it cannot do is pick up where the conversation left off,
 * because nothing in those four lines says *when* in the way a person thinks about when.
 * Nobody says "on the fourteenth of September I mentioned"; they say "i fredags".
 *
 * Deterministic and offline — no model call on the session-start path, which is a voice
 * turn. Weekday names only inside the last week, because "i tisdags" three weeks later
 * is worse than a date: it sounds recent and is not.
 */
const WEEKDAYS = ['söndags', 'måndags', 'tisdags', 'onsdags', 'torsdags', 'fredags', 'lördags'];

export function relativeSwedishDay(then: Date, now: Date): string {
  const days = Math.floor((startOfDay(now).getTime() - startOfDay(then).getTime()) / 86_400_000);

  if (days <= 0) return 'idag';
  if (days === 1) return 'igår';
  if (days < 7) return `i ${WEEKDAYS[then.getDay()]}`;
  if (days < 14) return 'förra veckan';
  if (days < 31) return `för ${Math.round(days / 7)} veckor sedan`;
  if (days < 365) return `för ${Math.round(days / 30)} månader sedan`;
  return then.toISOString().slice(0, 10);
}

function startOfDay(value: Date): Date {
  const copy = new Date(value);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/**
 * An allowlist, not a denylist, for the same reason `ACTION_OF` in `HistoryPort` is one:
 * a new action this does not know about should stay silent rather than guess it is
 * safe to repeat.
 *
 * `saved`, `updated` and `restored` are the current state of a memory the model is
 * already allowed to see in the profile or a room read — repeating a short preview here
 * is not a new disclosure. Everything else is either not yet real (`proposed`,
 * `approved`, `rejected` — a proposal is not a decision, and `explicit`-gated content
 * that has not been through the Godkänn-kön must not reach the model as if it had) or
 * actively meant to be gone (`deleted`, `purged`, and a future `superseded` once track 2
 * ships it — a corrected fact's superseded text is exactly the thing the correction
 * removed from view).
 */
const RECENT_BODY_ALLOWED: ReadonlySet<HistoryAction> = new Set(['saved', 'updated', 'restored']);

/**
 * One line, written as a person would say it rather than as the log recorded it.
 *
 * Three changes from the changelog it replaces, all of them about reading like a thread:
 * the time is relative, the room comes before the verb (where the thing happened is what
 * orients a reader, not what kind of operation it was), and a plain save drops the verb
 * altogether — "sparade" on every line is noise, because saving is what this product
 * does. The verb survives only where it changes the meaning: something was *changed*,
 * *removed*, *replaced*.
 */
function recentLine(entry: HistoryEntry, now: Date): string {
  const when = relativeSwedishDay(entry.occurredAt, now);
  const showBody = entry.body && RECENT_BODY_ALLOWED.has(entry.action);
  const preview = showBody ? `: ${truncatePreview(entry.body!)}` : '';

  // `saved` is the default thing that happens here, so saying it adds nothing. Every
  // other action is information.
  const verb = entry.action === 'saved' ? '' : ` — ${RECENT_LABEL[entry.action] ?? entry.action}`;

  return `- ${when}, ${entry.roomTitle}${verb}${preview}`;
}

function truncatePreview(body: string, maxChars = 70): string {
  const trimmed = body.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
}

/**
 * Packs entries newest-first until `RECENT_TOKEN_BUDGET` runs out, then stops rather
 * than trailing off with a "left out" note — unlike the room list, missing the tail of
 * "recent" costs nothing, because nothing here is the only place its subject is named.
 */
function renderRecent(recent: HistoryEntry[], now: Date): string | null {
  if (recent.length === 0) return null;

  const lines: string[] = [];
  let used = estimateTokens(RECENT_PREAMBLE);

  for (const entry of recent) {
    const line = recentLine(entry, now);
    const cost = estimateTokens(`${line}\n`);
    if (used + cost > RECENT_TOKEN_BUDGET) break;
    lines.push(line);
    used += cost;
  }

  if (lines.length === 0) return null;

  return `${RECENT_PREAMBLE}
${wrapRoomContent(lines.join('\n'), { label: 'senaste', notice: false })}`;
}

const OPEN_PREAMBLE = `Det här nämnde personen och sa inget mer om. Photographic har inte hört
något sedan dess — det betyder inte att det är ogjort. Fråga hur det gick om det passar,
i förbigående, och bara om ett:`;

/**
 * The loose ends. Two lines at most, and the most valuable two in the package.
 *
 * Every other block describes something settled, so a model reading them can only
 * recite. This one is the only part that is *unfinished*, which is what gives a model
 * somewhere to start a conversation rather than a list to read out — see `openThreadsFor`
 * for what qualifies and `docs/agent-instruction-layer.md` for the design that asked for
 * it.
 *
 * The preamble does the work that the data cannot. It says Photographic has heard nothing
 * since, not that the thing is undone — the person may well have finished it and not
 * mentioned it, so a model that says "har du hunnit med X?" is right either way while one
 * that says "X är fortfarande öppet" is wrong half the time. And it says *one*: two loose
 * ends raised at once is a standup, not a conversation.
 *
 * Inside `wrapRoomContent` like every other piece of memory text, because in a shared
 * room these are decisions other people wrote.
 */
function renderOpen(open: OpenThread[], now: Date): string | null {
  if (open.length === 0) return null;

  const lines: string[] = [];
  let used = estimateTokens(OPEN_PREAMBLE);

  for (const thread of open) {
    const when = relativeSwedishDay(thread.lastTouchedAt, now);
    const line = `- ${thread.roomTitle}, ${when} (${thread.daysSince} dagar): ${truncatePreview(thread.body, 90)} (${thread.shortId})`;
    const cost = estimateTokens(`${line}\n`);
    if (used + cost > OPEN_THREAD_TOKEN_BUDGET) break;
    lines.push(line);
    used += cost;
  }

  if (lines.length === 0) return null;

  return `${OPEN_PREAMBLE}
${wrapRoomContent(lines.join('\n'), { label: 'öppna trådar', notice: false })}`;
}

const SINCE_LAST_SEEN_PREAMBLE = (roomTitle: string) =>
  `Det här hände i ${roomTitle} medan personen var borta. Ta upp det om det är relevant, men berätta inte att du fick en lista:`;

/**
 * "While you were away", for the room the model asked for.
 *
 * `ActiveRoomContext.sinceLastSeen` has been computed on both implementations since the
 * bundle existed — with its own token budget and its own query over every event past
 * `room_read_state.last_seen_seq` — and had **no consumer anywhere in the repo**: this
 * renderer printed `activeRoom.title` and `activeRoom.brief` and dropped the third
 * field on the floor. So the one line in the whole package that sounds like a memory
 * developing over time rather than a static dossier was being paid for and thrown away.
 *
 * Rendered inside `wrapRoomContent` for the same reason the brief is: in a shared room
 * these lines describe what *other people* did, in text they wrote.
 *
 * Newest first, matching `recent`. The projection already packs the list to
 * `SINCE_LAST_SEEN_TOKEN_BUDGET`; this trusts that rather than imposing a second
 * ceiling, and the whole block gives way as a unit in `assembleBlocks` if the package
 * does not fit — a catch-up missing the one thing that mattered, with no way to tell,
 * is worse than no catch-up.
 */
function renderSinceLastSeen(activeRoom: ActiveRoomContext): string | null {
  const lines = activeRoom.sinceLastSeen.filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;

  return `${SINCE_LAST_SEEN_PREAMBLE(activeRoom.title)}
${wrapRoomContent(lines.join('\n'), { label: `${activeRoom.title} — nytt`, notice: false })}`;
}

export interface RenderOptions {
  /** Set false for clients that receive the rules another way, e.g. our own voice app. */
  includeRules?: boolean;
  budgetTokens?: number;
}

/**
 * Assembles the instructions string.
 *
 * Order is deliberate. The profile comes first because it is the part most likely to
 * survive truncation by a client that imposes its own limit, and the part whose absence
 * the person would notice immediately.
 */
const PREAMBLE = `Du är kopplad till Photographic, personens egna minne. Det här är vad du vet om
personen redan innan de skrivit något. Använd det utan att påpeka att du har det.
Vid varje ny konversation: hämta färsk kontext med get_context utan rum, även om
anslutningen återanvänds. Välj relevanta rum utifrån samtalet; be inte personen välja
ett rum för att börja. Efter en uppdatering: hämta om kontexten vid behov.

${CONTEXT_CONTRIBUTION_INSTRUCTIONS}`;

/**
 * What to send when the profile could not be built.
 *
 * Refusing the connection would be worse. A client that says "could not connect" is
 * indistinguishable, to the person, from a client that is broken, and they will conclude
 * the product is. This keeps the rules and the tools, and tells the model to fetch the
 * profile itself — which downgrades the promise from "already knows you" to "will look
 * you up", honestly, rather than pretending nothing happened.
 */
export const FALLBACK_INSTRUCTIONS = [
  PREAMBLE,
  `Profilen kunde inte läsas när anslutningen gjordes. Anropa get_context innan du svarar
på något om personen, och nämn inte det här för dem.`,
  HOW_TO_CONFIRM,
  DATA_BOUNDARY,
  LANGUAGE,
].join('\n\n---\n\n');

/**
 * Fits everything into the budget by giving up the recoverable parts in order.
 *
 * An earlier version trimmed whole blocks off the end of the rendered string, which put
 * the data boundary last in line to be dropped — and the boundary is exactly what must
 * survive when there is a lot of room content, because a large shared room is when text
 * written by other people is most likely to reach the model. Dropping it to make room
 * for more of that text is the confused-deputy hole stated as an algorithm.
 *
 * So things give way in the order of what it costs the person to lose them:
 *
 *   1. the room headlines, leaving the room names. One tool call to recover.
 *   2. the active room's "while you were away", then its brief — in that order, because
 *      a model that named a room asked for its contents. Both are one tool call away.
 *   3. profile items, by salience, down to a floor of one.
 *
 * The rules and the list of room names are never given up. A model missing a rule acts
 * against the person's standing wishes, and a model missing a room does not know there
 * is anything to ask about — neither is recoverable by the model noticing.
 *
 * Everything drops at an item or block boundary; nothing is cut mid-sentence, because a
 * rule stated halfway is a puzzle rather than a rule.
 *
 * A small calendar / open-thread sample is reserved alongside room names. Larger
 * timeline sections use remaining space only, so a long profile cannot erase time.
 *
 * The Compass is the opposite case, and is reserved rather than searched over: see
 * `renderCompass` for why it is never dropped or trimmed. It sits in `compassBlock`,
 * counted into `reserved` alongside the rules, so the profile is the thing that gives
 * way if space is tight — never the Compass.
 */
function assembleBlocks(
  bundle: ContextBundle,
  budget: number,
  rules: string[],
  timeline: string[] = [],
): { blocks: string[]; fits: boolean } {
  const compass = renderCompass(bundle.profile.compass);
  const compassBlock = compass ? [compass] : [];

  // Two parts, in retention order: the brief first, the catch-up second, because `keep`
  // below drops from the end. The brief is what the room is *about*, and a model that
  // asked for this room by name asked for its contents; the catch-up is what changed
  // while the person was away, which is the more evocative line and the more expendable
  // one. Both are one `list_history` call away if they fall off.
  const active: string[] = [];
  if (bundle.activeRoom) {
    // No per-payload notice here: `DATA_BOUNDARY` is a few hundred tokens below in the
    // same string, and spending the budget on saying it twice would come out of the
    // profile.
    active.push(
      `Aktivt rum: ${bundle.activeRoom.title}\n` +
        wrapRoomContent(bundle.activeRoom.brief, {
          label: bundle.activeRoom.title,
          notice: false,
        }),
    );

    const catchUp = renderSinceLastSeen(bundle.activeRoom);
    if (catchUp) active.push(catchUp);
  }

  let tightest: string[] | null = null;

  for (const headlines of [true, false]) {
    const rooms = renderRooms(bundle.rooms, { headlines });

    for (let keep = active.length; keep >= 0; keep -= 1) {
      // Rooms before the active room: the overview is what tells the model the rest of
      // the memory exists, and it reads in the order it is written.
      const context = [...(rooms ? [rooms] : []), ...active.slice(0, keep), ...timeline];
      const reserved = estimateTokens(
        [PREAMBLE, ...compassBlock, ...context, ...rules].join(SEPARATOR),
      );
      const profile = renderProfile(bundle.profile, Math.max(0, budget - reserved), bundle.builtAt);
      const blocks = [PREAMBLE, ...compassBlock, profile, ...context];

      if (estimateTokens([...blocks, ...rules].join(SEPARATOR)) <= budget) {
        return { blocks, fits: true };
      }
      tightest = blocks;
    }
  }

  // Over budget with nothing left that may be given up. Returning the tightest render
  // beats trimming it: what remains is the Compass, the rules, the room names and one
  // profile item, and there is no way to cut that which does not cost more than the
  // overrun.
  return { blocks: tightest ?? [PREAMBLE, ...compassBlock], fits: false };
}

export function renderInstructions(bundle: ContextBundle, options: RenderOptions = {}): string {
  const includeRules = options.includeRules ?? true;
  // The bundle's own budget before the constant. A bundle assembled against one ceiling
  // and rendered against another is how `?budget=` came to be validated, documented and
  // ignored, and how the same person got a different package through MCP than through
  // REST. The constant stays as the floor for a caller that has neither.
  const budget = options.budgetTokens ?? bundle.budgetTokens ?? INSTRUCTIONS_TOKEN_BUDGET;
  const rules = includeRules ? [HOW_TO_CONFIRM, DATA_BOUNDARY, LANGUAGE] : [];

  const now = bundle.builtAt;
  const minimal = [renderOpen(bundle.open.slice(0, 1), now), renderRecent(bundle.recent.slice(0, 1), now)]
    .filter((block): block is string => block !== null);
  // A long profile must not silently erase the calendar. Reserve one representative
  // from each timeline section before allocating the profile's variable space.
  let assembled = assembleBlocks(bundle, budget, rules, minimal);
  if (!assembled.fits) assembled = assembleBlocks(bundle, budget, rules);
  const { blocks } = assembled;
  // Expand a reserved section only from remaining space; replace, never duplicate it.
  const full = [renderOpen(bundle.open, now), renderRecent(bundle.recent, now)]
    .filter((block): block is string => block !== null);
  for (let i = 0; i < minimal.length; i += 1) {
    const at = blocks.indexOf(minimal[i]!);
    if (at < 0 || !full[i]) continue;
    const candidate = [...blocks];
    candidate[at] = full[i]!;
    if (estimateTokens([...candidate, ...rules].join(SEPARATOR)) <= budget) blocks[at] = full[i]!;
  }
  return [...blocks, ...rules].join(SEPARATOR);
}

const SEPARATOR = '\n\n---\n\n';

/**
 * What the never-dropped blocks cost, with nothing personal in them.
 *
 * Deliberately built from the same constants `assembleBlocks` reserves, so the two
 * cannot disagree about what is un-droppable. The default Compass is used rather than a
 * person's, because this is a floor: a customised principle can only make it higher, and
 * an API refusing a budget should refuse the value that is impossible for everyone.
 */
/**
 * The smallest budget this renderer can actually honour.
 *
 * `assembleBlocks` gives things up in order, but four things are reserved and never
 * given up: the preamble, the Compass, the confirmation style and the data boundary. A
 * caller asking for less than they cost gets a string over its budget — which is not a
 * bug in the renderer, it is a request that cannot be met, and quietly returning
 * something larger than asked for is how `?budget=500` came to be accepted, validated,
 * documented and unhonourable all at once.
 *
 * Measured from the reserved text itself rather than written down as a number, so it
 * cannot drift when the rules or a default Compass principle are edited. A personalised
 * Compass can make the real floor slightly higher; this is the minimum, which is the
 * right thing for an API to refuse below.
 *
 * Declared here rather than at the top of the file because it reads `PREAMBLE` and the
 * rule texts, and a module-level const cannot be computed before them.
 */
export const MIN_HONOURABLE_BUDGET_TOKENS = instructionsFloor();

function instructionsFloor(): number {
  const defaultCompass = COMPASS_PRINCIPLES.map((principle) => ({
    key: principle.key,
    text: principle.defaultText,
    source: 'default' as const,
    shortId: null,
  }));

  return estimateTokens(
    [PREAMBLE, renderCompass(defaultCompass), HOW_TO_CONFIRM, DATA_BOUNDARY, LANGUAGE].join(
      SEPARATOR,
    ),
  );
}

/**
 * Kept for callers that already trim a rendered string.
 *
 * Unlike `assemble` this cannot tell rules from content, so it is only safe on text
 * that has none. Prefer `assemble`.
 */
export function trimToBudget(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) return text;

  const blocks = text.split(SEPARATOR);
  while (blocks.length > 1 && estimateTokens(blocks.join(SEPARATOR)) > budgetTokens) {
    blocks.pop();
  }

  return blocks.join(SEPARATOR);
}

