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

import type { ContextBundle, Profile, RenderedItem, RoomSummary } from '@photographic/core';
import { ROOM_LIST_TOKEN_BUDGET, estimateTokens } from '@photographic/core';

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

function section(heading: string, items: RenderedItem[]): string | null {
  if (items.length === 0) return null;
  const lines = items.map((item) => `- ${item.body} (${item.shortId})`);
  return `${heading}\n${lines.join('\n')}`;
}

type SectionName = keyof Profile['sections'];

/** The order sections are printed in. */
const DISPLAY_ORDER: Array<{ name: SectionName; heading: string }> = [
  { name: 'identity', heading: 'Om personen' },
  { name: 'hardFacts', heading: 'Fakta' },
  { name: 'preferences', heading: 'Preferenser' },
  { name: 'instructions', heading: 'Så vill personen att du arbetar — följ detta' },
  { name: 'never', heading: 'Gör aldrig detta' },
  { name: 'currentFocus', heading: 'Håller på med just nu' },
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
export function renderProfile(profile: Profile, budgetTokens?: number): string {
  const selected = budgetTokens === undefined
    ? profile.sections
    : selectWithinBudget(profile.sections, budgetTokens);

  const parts = DISPLAY_ORDER.map(({ name, heading }) => section(heading, selected[name])).filter(
    (part): part is string => part !== null,
  );

  if (parts.length === 0) {
    return `Photographic har ännu inget sparat om den här personen. Det är normalt för
ett nytt konto. Spara det första du får veta som håller över tid — det är så minnet
kommer igång.`;
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
personen redan innan de skrivit något. Använd det utan att påpeka att du har det.`;

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
 *   2. the active room's brief, which the model asked for and can ask for again.
 *   3. profile items, by salience, down to a floor of one.
 *
 * The rules and the list of room names are never given up. A model missing a rule acts
 * against the person's standing wishes, and a model missing a room does not know there
 * is anything to ask about — neither is recoverable by the model noticing.
 *
 * Everything drops at an item or block boundary; nothing is cut mid-sentence, because a
 * rule stated halfway is a puzzle rather than a rule.
 */
export function renderInstructions(bundle: ContextBundle, options: RenderOptions = {}): string {
  const includeRules = options.includeRules ?? true;
  const budget = options.budgetTokens ?? INSTRUCTIONS_TOKEN_BUDGET;
  const rules = includeRules ? [HOW_TO_CONFIRM, DATA_BOUNDARY, LANGUAGE] : [];

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
  }

  let tightest: string | null = null;

  for (const headlines of [true, false]) {
    const rooms = renderRooms(bundle.rooms, { headlines });

    for (let keep = active.length; keep >= 0; keep -= 1) {
      // Rooms before the active room: the overview is what tells the model the rest of
      // the memory exists, and it reads in the order it is written.
      const context = [...(rooms ? [rooms] : []), ...active.slice(0, keep)];
      const reserved = estimateTokens([PREAMBLE, ...context, ...rules].join(SEPARATOR));
      const profile = renderProfile(bundle.profile, Math.max(0, budget - reserved));
      const out = [PREAMBLE, profile, ...context, ...rules].join(SEPARATOR);

      if (estimateTokens(out) <= budget) return out;
      tightest = out;
    }
  }

  // Over budget with nothing left that may be given up. Returning the tightest render
  // beats trimming it: what remains is the rules, the room names and one profile item,
  // and there is no way to cut that which does not cost more than the overrun.
  return tightest ?? [PREAMBLE, ...rules].join(SEPARATOR);
}

const SEPARATOR = '\n\n---\n\n';

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

