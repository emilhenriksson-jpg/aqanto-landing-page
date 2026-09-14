/**
 * Budgets and write policy.
 *
 * These numbers are product decisions, not tuning knobs. Change them deliberately.
 */

import type { ItemKind } from './domain.js';

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
export const ROOM_LIST_TOKEN_BUDGET = 100;

/** Cosine distance below which two items are treated as restating each other. */
export const DEDUPE_DISTANCE_THRESHOLD = 0.12;

/** Length above which a "small fact" is no longer small enough to auto-write. */
export const AUTO_WRITE_MAX_CHARS = 240;

/**
 * Kinds that always require explicit human approval regardless of everything else.
 *
 * An instruction changes the behaviour of every connected model simultaneously, so its
 * blast radius is the whole product rather than one answer. A wrong fact is annoying;
 * a wrong instruction ruins every chat at once.
 */
export const APPROVAL_REQUIRED_KINDS: readonly ItemKind[] = ['instruction', 'never'];

/** Kinds that may be written automatically when small and non-contradicting. */
export const AUTO_WRITABLE_KINDS: readonly ItemKind[] = [
  'identity',
  'fact',
  'preference',
  'decision',
  'note',
];

export function requiresApproval(input: {
  kind: ItemKind;
  body: string;
  contradicts: boolean;
  explicit: boolean;
  roomIsShared: boolean;
}): { required: true; reason: string } | { required: false } {
  if (input.explicit) return { required: false };

  if (APPROVAL_REQUIRED_KINDS.includes(input.kind)) {
    return {
      required: true,
      reason: `${input.kind} styr hur alla modeller beter sig och kräver alltid godkännande`,
    };
  }
  if (input.contradicts) {
    return { required: true, reason: 'motsäger något som redan finns i minnet' };
  }
  if (input.roomIsShared) {
    return { required: true, reason: 'delade rum skrivs bara efter uttrycklig begäran' };
  }
  if (input.body.length > AUTO_WRITE_MAX_CHARS) {
    return { required: true, reason: 'för långt för att sparas automatiskt' };
  }
  return { required: false };
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
export function generateShortId(prefix = 'p'): string {
  let out = '';
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) out += SHORT_ID_ALPHABET[b % SHORT_ID_ALPHABET.length];
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
