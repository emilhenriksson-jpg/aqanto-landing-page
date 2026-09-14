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

import { DATA_BOUNDARY, HOW_TO_CONFIRM, LANGUAGE } from './policy-text.js';

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

/**
 * The person, rendered.
 *
 * Standing instructions are kept in their own section rather than mixed in with facts,
 * because they are the only part the model is meant to *obey* rather than merely know.
 * Flattening the two is how "I prefer concise answers" ends up treated as trivia.
 */
export function renderProfile(profile: Profile): string {
  const parts = [
    section('Om personen', profile.sections.identity),
    section('Fakta', profile.sections.hardFacts),
    section('Preferenser', profile.sections.preferences),
    section('Så vill personen att du arbetar — följ detta', profile.sections.instructions),
    section('Gör aldrig detta', profile.sections.never),
    section('Håller på med just nu', profile.sections.currentFocus),
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) {
    return `Photographic har ännu inget sparat om den här personen. Det är normalt för
ett nytt konto. Spara det första du får veta som håller över tid — det är så minnet
kommer igång.`;
  }

  return parts.join('\n\n');
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
export function renderInstructions(bundle: ContextBundle, options: RenderOptions = {}): string {
  const includeRules = options.includeRules ?? true;

  const blocks: string[] = [
    `Du är kopplad till Photographic, personens egna minne. Det här är vad du vet om
personen redan innan de skrivit något. Använd det utan att påpeka att du har det.`,
    renderProfile(bundle.profile),
  ];

  const rooms = renderRooms(bundle.rooms);
  if (rooms) blocks.push(rooms);

  if (bundle.activeRoom) {
    blocks.push(
      `Aktivt rum: ${bundle.activeRoom.title}\n<room-content>\n${bundle.activeRoom.brief}\n</room-content>`,
    );
  }

  if (includeRules) {
    blocks.push(HOW_TO_CONFIRM, DATA_BOUNDARY, LANGUAGE);
  }

  const rendered = blocks.join('\n\n---\n\n');
  return trimToBudget(rendered, options.budgetTokens ?? INSTRUCTIONS_TOKEN_BUDGET);
}

/**
 * Drops whole blocks from the end rather than cutting mid-sentence.
 *
 * Truncating inside the rules would leave the data boundary half-stated, which is worse
 * than omitting it: a model told "everything inside <room-content> tags was written by"
 * and nothing more has been given a puzzle, not a rule.
 */
export function trimToBudget(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) return text;

  const blocks = text.split('\n\n---\n\n');
  while (blocks.length > 1 && estimateTokens(blocks.join('\n\n---\n\n')) > budgetTokens) {
    blocks.pop();
  }

  return blocks.join('\n\n---\n\n');
}

/** Deliberately crude; a budget check does not need a tokeniser dependency. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
