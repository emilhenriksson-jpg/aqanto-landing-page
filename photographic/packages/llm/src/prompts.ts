/**
 * Prompts, response schemas and response validation, shared by every provider.
 *
 * Extraction quality is a product decision, not an OpenAI detail, so the wording lives
 * here and both `OpenAiLlm` and `AnthropicLlm` send the same instructions. When the
 * prompt changes, both providers change together and the tests below catch drift.
 */

import type { ItemKind } from '@photographic/core';
import { dedupeHash, estimateTokens } from '@photographic/core';

/**
 * Exhaustive by construction: a new `ItemKind` in the frozen contract fails to compile
 * here rather than silently never being extracted.
 */
const KIND_COVERAGE: Record<ItemKind, true> = {
  identity: true,
  fact: true,
  preference: true,
  instruction: true,
  decision: true,
  note: true,
  never: true,
};

export const ITEM_KINDS: ItemKind[] = Object.keys(KIND_COVERAGE) as ItemKind[];

const ITEM_KIND_SET = new Set<string>(ITEM_KINDS);

/** The subset of JSON Schema both providers accept for structured output. */
export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface ExtractedFact {
  body: string;
  kind: ItemKind;
  confidence: number;
}

/** How many facts one passage may yield. A passage that "contains" more is a red flag. */
export const MAX_FACTS_PER_PASSAGE = 12;

/** Longer than this is a paragraph, not a fact, and belongs in a document instead. */
export const MAX_FACT_CHARS = 400;

/** Input guard so a runaway transcript cannot turn into a runaway bill. */
export const MAX_PROMPT_CHARS = 24_000;

export const EXTRACT_SYSTEM_PROMPT = [
  'Du extraherar varaktiga, återanvändbara fakta om en person till ett permanent minne',
  'som läses av vilken AI-modell personen än pratar med imorgon.',
  '',
  'The only test that matters: would this still be worth telling a different model in a',
  'year, about this person, with no other context? If not, do not extract it.',
  '',
  'EXTRACT (durable, reusable, about the person or their world):',
  '- identity: names, relationships, where they live, what they do.',
  '  "dottern heter Vera", "bor i Uppsala", "jobbar som snickare".',
  '- fact: stable circumstances, constraints, health, allergies, ownership.',
  '  "allergisk mot ketchup", "har körkort men ingen bil".',
  '- preference: lasting likes, dislikes and ways of working.',
  '  "föredrar korta svar", "dricker inte kaffe efter 14".',
  '- instruction: a standing rule the person wants every model to follow.',
  '  "svara alltid på svenska", "utmana mig istället för att hålla med".',
  '- decision: a choice made that later conversations must respect.',
  '- never: something the person does not want mentioned or done.',
  '- note: durable context that fits none of the above.',
  '',
  'DO NOT EXTRACT:',
  '- Transient chat content: what is happening right now, the weather, small talk,',
  '  what the person is doing this minute, one-off questions.',
  '- Tasks, reminders, todos or plans for a single occasion.',
  '- Anything the assistant said, proposed, offered, summarised or concluded. Only the',
  '  person\'s own statements about themselves count. An assistant suggestion is never',
  '  a fact about the person.',
  '- Speculation, inference or anything you had to guess at. If it is not stated, skip it.',
  '- Anything already present in KNOWN FACTS, including paraphrases of it.',
  '',
  'RULES:',
  '- Returning an empty list is the correct and common answer. Most passages contain',
  '  nothing durable. Never invent a fact to look useful.',
  '- One fact per entry, third person about the person, written in the language the',
  '  person used, short and self-contained so it reads correctly with no surrounding',
  '  conversation.',
  '- Keep the person\'s own wording where possible; do not editorialise or expand.',
  '- confidence is 0-1: 0.9+ only when the person stated it plainly about themselves,',
  '  below 0.6 when you are unsure it is durable. Prefer omitting over a low score.',
  `- Never return more than ${MAX_FACTS_PER_PASSAGE} facts.`,
].join('\n');

export const FACTS_SCHEMA_NAME = 'extracted_facts';

export const FACTS_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      description: 'Durable, reusable facts. Empty when the passage contains none.',
      items: {
        type: 'object',
        properties: {
          body: {
            type: 'string',
            description: 'The fact, third person, in the language the person used.',
          },
          kind: { type: 'string', enum: ITEM_KINDS },
          confidence: { type: 'number', description: '0-1 confidence that this is durable.' },
        },
        required: ['body', 'kind', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['facts'],
  additionalProperties: false,
};

export function buildExtractUserMessage(input: { text: string; existing: string[] }): string {
  const known = input.existing.length
    ? input.existing.map((e) => `- ${e}`).join('\n')
    : '(inga kända fakta ännu)';
  return [
    'KNOWN FACTS (already stored, never re-emit these or paraphrases of them):',
    truncate(known, MAX_PROMPT_CHARS),
    '',
    'PASSAGE:',
    truncate(input.text, MAX_PROMPT_CHARS),
  ].join('\n');
}

/**
 * Normalises a model response into facts we are willing to store.
 *
 * The `existing` filter is applied again here even though the prompt forbids repeats:
 * a duplicate that slips through costs a row in the personal profile, which has a hard
 * token ceiling, so cheap deterministic defence is worth it.
 */
export function parseFacts(raw: unknown, existing: string[]): ExtractedFact[] {
  const facts = (raw as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(facts)) return [];

  const seen = new Set(existing.map(dedupeHash));
  const out: ExtractedFact[] = [];

  for (const entry of facts) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { body?: unknown; kind?: unknown; confidence?: unknown };

    const body = typeof candidate.body === 'string' ? candidate.body.trim() : '';
    if (body.length < 2 || body.length > MAX_FACT_CHARS) continue;

    const hash = dedupeHash(body);
    if (hash.length === 0 || seen.has(hash)) continue;

    const kind: ItemKind =
      typeof candidate.kind === 'string' && ITEM_KIND_SET.has(candidate.kind)
        ? (candidate.kind as ItemKind)
        : 'note';

    const confidence =
      typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
        ? Math.min(1, Math.max(0, candidate.confidence))
        : 0.5;

    seen.add(hash);
    out.push({ body, kind, confidence });
    if (out.length >= MAX_FACTS_PER_PASSAGE) break;
  }

  return out;
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

export type CompareVerdict = 'same' | 'contradicts' | 'unrelated';

/**
 * Below this, a `same` or `unrelated` verdict is downgraded to `contradicts`.
 *
 * The verdict decides whether a write happens silently or asks the person first. A
 * needless approval prompt costs one tap; a wrong memory written silently is the thing
 * the product promises never to do. So uncertainty resolves toward asking.
 */
export const COMPARE_CONFIDENCE_FLOOR = 0.6;

export const COMPARE_SYSTEM_PROMPT = [
  'You compare a CANDIDATE statement against an EXISTING stored memory about the same',
  'person and return exactly one verdict.',
  '',
  '- same: they state the same thing. Wording, language or detail may differ, but',
  '  storing both would be a duplicate.',
  '- contradicts: they cannot both be true of the person at the same time, or the',
  '  candidate replaces/updates the existing one (moved, changed job, changed mind,',
  '  a different value for the same single-valued attribute).',
  '- unrelated: different subjects entirely. Both can be stored side by side.',
  '',
  'Same attribute with a different value is contradicts, not unrelated:',
  '"bor i Uppsala" vs "bor i Stockholm" contradicts. Different attributes about the',
  'same topic are unrelated: "bor i Uppsala" vs "gillar Uppsala".',
  '',
  'When you are genuinely uncertain, answer contradicts. A verdict of same or',
  'unrelated causes an automatic write; contradicts asks the person first, which is the',
  'safe direction to be wrong in. Set confidence honestly and low when unsure.',
].join('\n');

export const COMPARE_SCHEMA_NAME = 'comparison_verdict';

export const COMPARE_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['same', 'contradicts', 'unrelated'] },
    confidence: { type: 'number', description: '0-1 confidence in the verdict.' },
  },
  required: ['verdict', 'confidence'],
  additionalProperties: false,
};

export function buildCompareUserMessage(candidate: string, existing: string): string {
  return [
    'CANDIDATE:',
    truncate(candidate, MAX_PROMPT_CHARS),
    '',
    'EXISTING:',
    truncate(existing, MAX_PROMPT_CHARS),
  ].join('\n');
}

/** Anything unparseable, unknown or low-confidence becomes `contradicts`. */
export function parseCompare(raw: unknown): CompareVerdict {
  const parsed = raw as { verdict?: unknown; confidence?: unknown } | null;
  const verdict = parsed?.verdict;
  if (verdict !== 'same' && verdict !== 'unrelated') return 'contradicts';

  const confidence = typeof parsed?.confidence === 'number' ? parsed.confidence : 0;
  if (!Number.isFinite(confidence) || confidence < COMPARE_CONFIDENCE_FLOOR) return 'contradicts';

  return verdict;
}

// ---------------------------------------------------------------------------
// summarise
// ---------------------------------------------------------------------------

export const SUMMARISE_SYSTEM_PROMPT = [
  'You compress notes about a person or a shared room into a briefing another AI model',
  'reads before it starts talking to them.',
  '',
  '- Keep names, numbers, dates, decisions, constraints and anything the person would',
  '  be annoyed to have to repeat.',
  '- Drop pleasantries, process talk and anything already obvious from context.',
  '- Write in the language of the source notes. Plain prose or short lines, no preamble,',
  '  no headings, no "here is a summary".',
  '- Never exceed the token budget you are given. Under budget is fine.',
].join('\n');

/**
 * The room overview every session opens with, one sentence per room.
 *
 * A different job from `SUMMARISE_SYSTEM_PROMPT`, not a shorter one. This sentence is
 * read while a model decides whether a room is worth opening, so it has to say what the
 * room is for; the most recent three facts, compressed, tell a model nothing about that
 * and read like an answer it can use without opening anything.
 */
export const HEADLINE_SYSTEM_PROMPT = [
  'You write the one-line description of a room in a personal memory system. A room is a',
  'space where someone keeps notes on one part of their life or work, sometimes shared',
  'with other people.',
  '',
  'You are given notes from inside the room. Say what the room is for, not what the notes',
  'say. Another AI model reads your sentence to decide whether to open the room, so name',
  'the subject and the kind of thing kept there.',
  '',
  '- One sentence. No final full stop needed, no preamble, no "this room contains".',
  '- Name the recurring subject: the project, the property, the company, the group.',
  '- Concrete over general: "Renovering av villan: offerter, hantverkare och tidplan"',
  '  beats "Anteckningar om ett hus".',
  '- Leave out specific figures, dates and names of individuals. They belong in the room,',
  '  not in a line every session reads.',
  '- Write in the language of the notes.',
].join('\n');

export function buildSummariseUserMessage(input: { texts: string[]; budgetTokens: number }): string {
  return [
    `TOKEN BUDGET: ${input.budgetTokens}. The summary must fit inside it.`,
    '',
    'NOTES:',
    truncate(input.texts.map((t) => t.trim()).filter(Boolean).join('\n---\n'), MAX_PROMPT_CHARS),
  ].join('\n');
}

/**
 * Hard-enforces the budget the model was asked to respect, because the profile is
 * injected whole into every session and a summary that overshoots evicts real facts.
 * Cuts at a sentence boundary, then a word boundary, before cutting mid-word.
 */
export function clampToBudget(text: string, budgetTokens: number): string {
  const trimmed = text.trim();
  if (budgetTokens <= 0) return '';
  if (estimateTokens(trimmed) <= budgetTokens) return trimmed;

  const maxChars = Math.floor(budgetTokens * 3.6);
  const window = trimmed.slice(0, maxChars);

  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('.\n'),
    window.lastIndexOf('!'),
    window.lastIndexOf('?'),
    window.lastIndexOf('\n'),
  );
  if (sentenceEnd >= maxChars * 0.5) return window.slice(0, sentenceEnd + 1).trim();

  const wordEnd = window.lastIndexOf(' ');
  if (wordEnd >= maxChars * 0.5) return window.slice(0, wordEnd).trim();

  return window.trim();
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[...avklippt]`;
}

/** Every provider fails the same way when a response cannot be used. */
export class LlmResponseError extends Error {
  override readonly name = 'LlmResponseError';

  constructor(message: string, readonly provider: string) {
    super(`${provider}: ${message}`);
  }
}

export function parseJsonObject(text: string | null | undefined, provider: string): unknown {
  if (text === null || text === undefined || text.trim() === '') {
    throw new LlmResponseError('empty response', provider);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LlmResponseError('response was not valid JSON', provider);
  }
}
