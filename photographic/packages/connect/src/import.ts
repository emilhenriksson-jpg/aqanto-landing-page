/**
 * Cold start.
 *
 * An empty memory layer has no value on the day the person decides whether to keep it.
 * They have usually already accumulated thirty or forty facts inside ChatGPT, so the
 * fastest route to a profile worth having is to let them paste that list in. Both
 * Supermemory and Mem0 offer a one-click import of ChatGPT's saved memories, and it is
 * the one piece of competitor onboarding worth copying outright.
 *
 * Ours differs in one respect: nothing is written. Every line becomes a proposal, shown
 * together with an approve-all button. Silently absorbing memories another system
 * extracted means inheriting its mistakes, and the person has no way to tell which of
 * those forty lines were wrong until a model acts on one.
 *
 * Parsing is deliberately done with rules rather than a model. It runs instantly, costs
 * nothing, is identical every time, and the person is about to review the output line by
 * line anyway — which is a better check than any classifier.
 */

import type { ItemKind } from '@photographic/core';

/** Shorter than this is not a memory; longer is a document. */
const MIN_LENGTH = 8;
const MAX_LENGTH = 400;

/**
 * Noise that comes along when someone selects the memory list in ChatGPT's settings and
 * copies it. Matching the interface chrome rather than the content.
 */
const CHROME = [
  /^memory updated$/i,
  /^saved memor(y|ies)$/i,
  /^manage memor(y|ies)$/i,
  /^personalization$/i,
  /^what should chatgpt call you\??$/i,
  /^reference saved memories$/i,
  /^delete all$/i,
  /^(delete|edit|remove|forget)$/i,
  /^\d+ memor(y|ies)$/i,
  /^settings$/i,
  /^customize chatgpt$/i,
];

/** Leading list markers, in every shape a paste produces. */
const BULLET = /^\s*(?:[-*\u2022\u2013\u2014\u25cf\u25aa]|\d+[.)]|\[[ x]\])\s+/i;

/**
 * Third-person framing that ChatGPT's own memories use. Stripped so the imported line
 * reads the way the person would say it about themselves, which is how every other
 * memory in Photographic is written.
 */
const THIRD_PERSON = [
  // Possessive first: "the user's daughter" keeps the daughter, not a stray verb match.
  /^(?:the\s+)?user['\u2019]s\s+/i,
  /^användarens\s+/i,
  /^(?:the\s+)?user\s+(?:is|has|likes|prefers|wants|works|lives|uses|said|mentioned|indicated|stated)\s+/i,
  /^(?:the\s+)?user\s+/i,
  /^användaren\s+(?:är|har|vill|gillar|föredrar|arbetar|bor|använder)\s+/i,
  /^användaren\s+/i,
  /^(?:they|he|she)\s+(?:is|has|prefers|likes|wants)\s+/i,
  /^(?:han|hon|hen)\s+(?:är|har|gillar|föredrar|vill)\s+/i,
];

/** Hedged reporting that adds nothing once the line is in a memory store. */
const HEDGES = [
  /^(?:has\s+)?(?:mentioned|said|told me|indicated|stated|noted)\s+that\s+/i,
  /^(?:nämnde|sa|berättade)\s+att\s+/i,
  // Left behind once the reporting verb above it has been stripped.
  /^that\s+/i,
  /^att\s+/i,
];

/**
 * Imperative phrasing. These become `instruction`, which always requires approval, so
 * an over-eager match here costs the person one extra glance rather than a silently
 * altered model.
 */
const INSTRUCTION_MARKERS = [
  /\b(?:always|never|don't|do not|avoid|make sure|be sure to|remember to|please)\b/i,
  /\b(?:respond|reply|answer|write|format|explain|address)\b.*\b(?:in|as|with|using)\b/i,
  /\b(?:alltid|aldrig|undvik|se till att|svara|formulera)\b/i,
  /\bprefers? (?:you|that you|responses?|answers?)\b/i,
];

const PREFERENCE_MARKERS = [
  /\b(?:prefers?|likes?|dislikes?|favourite|favorite|enjoys?|hates?)\b/i,
  /\b(?:föredrar|gillar|tycker om|ogillar|älskar|hatar)\b/i,
];

const NEVER_MARKERS = [
  /\b(?:never|don't ever|under no circumstances)\b/i,
  /\b(?:aldrig|under inga omständigheter)\b/i,
];

const IDENTITY_MARKERS = [
  /\b(?:name is|called|works as|job title|lives in|based in|is a|is an)\b/i,
  /\b(?:heter|jobbar som|bor i|är en|är ett)\b/i,
];

/** Things that must never be imported, no matter how the paste is shaped. */
const SECRET_MARKERS = [
  /\b(?:sk-[a-z0-9]{8,}|ghp_[a-z0-9]{8,}|xox[baprs]-)/i,
  /\b(?:password|passphrase|api[ -]?key|secret[ -]?key|token|cvv|personnummer)\b\s*[:=]/i,
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/,
];

export type ImportSource = 'chatgpt' | 'claude' | 'other';

export interface ImportCandidate {
  text: string;
  kind: ItemKind;
  /** False only for plain facts and preferences short enough to land on their own. */
  needsApproval: boolean;
  /** Present when we changed the wording, so the review screen can show both. */
  original?: string;
}

export interface ImportPreview {
  source: ImportSource;
  candidates: ImportCandidate[];
  /** Lines dropped, with why, so the person can see nothing vanished silently. */
  skipped: Array<{ text: string; reason: 'too_short' | 'too_long' | 'duplicate' | 'chrome' | 'secret' }>;
}

/** A paste from ChatGPT's memory list looks different from a hand-written list. */
export function detectSource(text: string): ImportSource {
  if (/saved memor(y|ies)|memory updated|reference saved memories/i.test(text)) return 'chatgpt';
  if (/claude|projects? knowledge/i.test(text)) return 'claude';
  return 'other';
}

function splitLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return [];
      // ChatGPT's list sometimes copies as one long line with bullets inline.
      if (!trimmed.includes('\u2022')) return [trimmed];
      return trimmed.split('\u2022').map((part) => part.trim()).filter(Boolean);
    });
}

function clean(line: string): string {
  let out = line.replace(BULLET, '').trim();

  // Two passes, because stripping a reporting verb exposes the pronoun behind it:
  // "User mentioned that he is allergic" needs the verb gone before "he is" is visible.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const pattern of THIRD_PERSON) out = out.replace(pattern, '');
    for (const pattern of HEDGES) out = out.replace(pattern, '');
  }

  out = out.replace(/\s+/g, ' ').trim();
  // Sentence case, but only when the first word is not already a name or acronym.
  if (out.length > 0 && /^[a-zåäö]/.test(out)) out = out[0]!.toUpperCase() + out.slice(1);
  return out.replace(/[.,;]+$/, '');
}

export function classify(text: string): ItemKind {
  if (NEVER_MARKERS.some((p) => p.test(text)) && INSTRUCTION_MARKERS.some((p) => p.test(text))) {
    return 'never';
  }
  if (INSTRUCTION_MARKERS.some((p) => p.test(text))) return 'instruction';
  if (PREFERENCE_MARKERS.some((p) => p.test(text))) return 'preference';
  if (IDENTITY_MARKERS.some((p) => p.test(text))) return 'identity';
  return 'fact';
}

/**
 * Turns a paste into reviewable candidates. Never writes anything, and never throws on
 * malformed input: an import screen that rejects a paste is an import screen nobody
 * completes.
 */
export function previewImport(text: string): ImportPreview {
  const seen = new Set<string>();
  const candidates: ImportCandidate[] = [];
  const skipped: ImportPreview['skipped'] = [];

  for (const raw of splitLines(text)) {
    const stripped = raw.replace(BULLET, '').trim();

    if (CHROME.some((pattern) => pattern.test(stripped))) {
      skipped.push({ text: stripped, reason: 'chrome' });
      continue;
    }
    if (SECRET_MARKERS.some((pattern) => pattern.test(stripped))) {
      // Not echoed back. A screen that redisplays a pasted API key has copied it into
      // one more place.
      skipped.push({ text: '[utelämnat]', reason: 'secret' });
      continue;
    }

    const cleaned = clean(raw);
    if (cleaned.length < MIN_LENGTH) {
      skipped.push({ text: stripped, reason: 'too_short' });
      continue;
    }
    if (cleaned.length > MAX_LENGTH) {
      skipped.push({ text: stripped, reason: 'too_long' });
      continue;
    }

    const key = cleaned.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (seen.has(key)) {
      skipped.push({ text: stripped, reason: 'duplicate' });
      continue;
    }
    seen.add(key);

    const kind = classify(cleaned);
    const candidate: ImportCandidate = {
      text: cleaned,
      kind,
      // Instructions and `never` change behaviour rather than describing the person, so
      // they stay behind an explicit yes even in a bulk approve.
      needsApproval: kind === 'instruction' || kind === 'never',
    };
    if (cleaned !== stripped) candidate.original = stripped;

    candidates.push(candidate);
  }

  return { source: detectSource(text), candidates, skipped };
}
