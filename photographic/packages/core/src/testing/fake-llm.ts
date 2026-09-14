import { createHash } from 'node:crypto';
import type { ItemKind } from '../domain.js';
import type { LlmPort } from '../ports.js';
import { dedupeHash } from '../policy.js';

/**
 * Deterministic stand-in for a real model, so the suite runs offline, free and fast.
 *
 * Embeddings are hash-derived but stable and direction-sensitive: identical text gives
 * an identical vector and near-identical text gives a near vector, which is enough to
 * exercise the dedupe threshold without a network call.
 */
export class FakeLlm implements LlmPort {
  readonly calls: { embed: number; extract: number; compare: number; summarise: number } = {
    embed: 0,
    extract: 0,
    compare: 0,
    summarise: 0,
  };

  constructor(private readonly dimensions = 1536) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.embed += 1;
    return texts.map((t) => this.vectorFor(t));
  }

  /**
   * Splits on sentence boundaries and keeps clauses that look like durable statements.
   * Crude on purpose: tests assert on the pipeline, not on extraction quality.
   */
  async extractFacts(input: {
    text: string;
    existing: string[];
  }): Promise<Array<{ body: string; kind: ItemKind; confidence: number }>> {
    this.calls.extract += 1;
    const known = new Set(input.existing.map(dedupeHash));
    return input.text
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 8 && s.length <= 240)
      .filter((s) => !known.has(dedupeHash(s)))
      .map((body) => ({ body, kind: classify(body), confidence: 0.8 }));
  }

  async compare(a: string, b: string): Promise<'same' | 'contradicts' | 'unrelated'> {
    this.calls.compare += 1;
    if (dedupeHash(a) === dedupeHash(b)) return 'same';

    // A negation on one side of otherwise-similar text is treated as a contradiction,
    // which is the case the write-tiering logic actually needs to exercise.
    const na = hasNegation(a);
    const nb = hasNegation(b);
    if (na !== nb && overlap(a, b) > 0.5) return 'contradicts';
    if (overlap(a, b) > 0.75) return 'same';
    return 'unrelated';
  }

  async summarise(input: { texts: string[]; budgetTokens: number }): Promise<string> {
    this.calls.summarise += 1;
    const maxChars = input.budgetTokens * 3;
    let out = '';
    for (const t of input.texts) {
      if (out.length + t.length + 2 > maxChars) break;
      out += (out ? '\n' : '') + t.trim();
    }
    return out;
  }

  private vectorFor(text: string): number[] {
    const normalised = dedupeHash(text);
    const tokens = normalised.split(' ').filter(Boolean);
    const vec = new Array<number>(this.dimensions).fill(0);

    // Per-token hashing means shared words pull two vectors together, so paraphrases
    // land close and unrelated text does not.
    for (const token of tokens) {
      const digest = createHash('sha256').update(token).digest();
      for (let i = 0; i < digest.length; i += 2) {
        const slot = ((digest[i]! << 8) | digest[i + 1]!) % this.dimensions;
        vec[slot] = (vec[slot] ?? 0) + 1;
      }
    }

    const norm = Math.hypot(...vec) || 1;
    return vec.map((v) => v / norm);
  }
}

const NEGATIONS = ['inte', 'aldrig', 'ingen', 'inget', 'not', 'never', 'no longer'];

function hasNegation(text: string): boolean {
  const t = ` ${dedupeHash(text)} `;
  return NEGATIONS.some((n) => t.includes(` ${n} `));
}

function overlap(a: string, b: string): number {
  const sa = new Set(dedupeHash(a).split(' ').filter(Boolean));
  const sb = new Set(dedupeHash(b).split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared += 1;
  return shared / Math.min(sa.size, sb.size);
}

function classify(body: string): ItemKind {
  const t = dedupeHash(body);
  if (/\b(alltid|aldrig|ska du|utmana|svara)\b/.test(t)) return 'instruction';
  if (/\b(gillar|föredrar|prefers|hellre)\b/.test(t)) return 'preference';
  if (/\b(heter|bor|jobbar|arbetar|gift|dotter|son)\b/.test(t)) return 'identity';
  return 'fact';
}
