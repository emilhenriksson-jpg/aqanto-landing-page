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
import { estimateTokens } from '@photographic/core';

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

function renderRooms(rooms: RoomSummary[]): string | null {
  const shared = rooms.filter((room) => room.role !== undefined && room.slug !== 'personal');
  if (shared.length === 0) return null;

  const lines = shared.map((room) => {
    const unseen = room.unseenCount > 0 ? ` · ${room.unseenCount} nya` : '';
    return `- ${room.title}: ${room.oneLine}${unseen}`;
  });

  return `Rum personen kan nå. Säg namnet som det står här när du sparar eller söker.
${lines.join('\n')}`;
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
 * Fits everything into the budget by dropping context, never rules.
 *
 * The earlier version of this trimmed whole blocks off the end of the rendered string,
 * which put the data boundary last in line to be dropped — and the boundary is exactly
 * what must survive when there is a lot of room content, because a large shared room is
 * when text written by other people is most likely to reach the model. Dropping it to
 * make room for more of that text is the confused-deputy hole stated as an algorithm.
 *
 * So the rules are reserved first, then the optional context, and the profile is
 * rendered into whatever is left. Everything drops at an item or block boundary; nothing
 * is ever cut mid-sentence, because a rule stated halfway is a puzzle rather than a rule.
 */
export function renderInstructions(bundle: ContextBundle, options: RenderOptions = {}): string {
  const includeRules = options.includeRules ?? true;
  const budget = options.budgetTokens ?? INSTRUCTIONS_TOKEN_BUDGET;
  const rules = includeRules ? [HOW_TO_CONFIRM, DATA_BOUNDARY, LANGUAGE] : [];

  // Optional before the profile, because the model can ask for a room list or a brief
  // with a tool call. It cannot ask for context it was never told exists.
  const optional: string[] = [];
  const rooms = renderRooms(bundle.rooms);
  if (rooms) optional.push(rooms);
  if (bundle.activeRoom) {
    optional.push(
      `Aktivt rum: ${bundle.activeRoom.title}\n${wrapRoomContent(bundle.activeRoom.brief)}`,
    );
  }

  for (let keep = optional.length; keep >= 0; keep -= 1) {
    const context = optional.slice(0, keep);
    const reserved = estimateTokens([PREAMBLE, ...context, ...rules].join(SEPARATOR));
    const profile = renderProfile(bundle.profile, Math.max(0, budget - reserved));
    const out = [PREAMBLE, profile, ...context, ...rules].join(SEPARATOR);

    if (keep === 0 || estimateTokens(out) <= budget) return out;
  }

  // Unreachable: the loop returns at keep === 0.
  return [PREAMBLE, ...rules].join(SEPARATOR);
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

/**
 * Wraps text written by other people.
 *
 * Every path that puts shared-room content in front of a model goes through this, so the
 * boundary cannot be forgotten at one call site. Closing tags inside the content are
 * neutralised, because a memory containing a literal `</room-content>` would otherwise
 * end the boundary early and put whatever follows in instruction position.
 */
export function wrapRoomContent(text: string): string {
  const safe = text.replace(/<\/?room-content>/gi, '[room-content]');
  return `<room-content>\n${safe}\n</room-content>`;
}
