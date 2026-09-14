import { describe, expect, it } from 'vitest';
import {
  AUTO_WRITE_MAX_CHARS,
  PROFILE_TOKEN_BUDGET,
  dedupeHash,
  estimateTokens,
  generateShortId,
  requiresApproval,
} from './policy.js';
import { FakeLlm } from './testing/fake-llm.js';

describe('write policy', () => {
  const base = { contradicts: false, explicit: false, roomIsShared: false };

  it('lets a small non-contradicting fact through without asking', () => {
    expect(requiresApproval({ ...base, kind: 'fact', body: 'allergisk mot ketchup' })).toEqual({
      required: false,
    });
  });

  it('always asks before storing an instruction', () => {
    // An instruction changes every connected model's behaviour at once, so its blast
    // radius is the whole product rather than one answer.
    const result = requiresApproval({
      ...base,
      kind: 'instruction',
      body: 'utmana alltid mina idéer',
    });
    expect(result.required).toBe(true);
  });

  it('asks when the new fact contradicts something already known', () => {
    const result = requiresApproval({ ...base, kind: 'fact', body: 'bor i Malmö', contradicts: true });
    expect(result.required).toBe(true);
  });

  it('asks before writing to a shared room unless the person said so', () => {
    expect(requiresApproval({ ...base, kind: 'fact', body: 'x', roomIsShared: true }).required).toBe(true);
    expect(
      requiresApproval({ ...base, kind: 'fact', body: 'x', roomIsShared: true, explicit: true }).required,
    ).toBe(false);
  });

  it('refuses to auto-write long passages', () => {
    const long = 'a'.repeat(AUTO_WRITE_MAX_CHARS + 1);
    expect(requiresApproval({ ...base, kind: 'note', body: long }).required).toBe(true);
  });
});

describe('short ids', () => {
  it('avoids characters that are ambiguous when spoken', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateShortId()).toMatch(/^p-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/);
    }
  });
});

describe('dedupe hash', () => {
  it('collapses casing, accents and punctuation', () => {
    expect(dedupeHash('Allergisk mot Ketchup!')).toBe(dedupeHash('allergisk  mot ketchup'));
  });

  it('keeps genuinely different statements apart', () => {
    expect(dedupeHash('allergisk mot ketchup')).not.toBe(dedupeHash('allergisk mot senap'));
  });
});

describe('token estimate', () => {
  it('stays under the profile budget for a realistic profile', () => {
    const profile = [
      'Heter Emil Henriksson.',
      'Har en dotter.',
      'Allergisk mot ketchup.',
      'Bor i Sverige, arbetar med förvärv och bokföring.',
      'Vill alltid bli utmanad, inte bekräftad.',
    ].join('\n');
    expect(estimateTokens(profile)).toBeLessThan(PROFILE_TOKEN_BUDGET);
  });
});

describe('FakeLlm', () => {
  const llm = new FakeLlm();

  it('produces stable, normalised embeddings', async () => {
    const [a, b] = await llm.embed(['allergisk mot ketchup', 'allergisk mot ketchup']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1536);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 5);
  });

  it('places paraphrases nearer than unrelated text', async () => {
    const [base, near, far] = await llm.embed([
      'allergisk mot ketchup',
      'allergisk mot ketchup och senap',
      'kvartalsrapporten för Buyersclub',
    ]);
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(cos(base!, near!)).toBeGreaterThan(cos(base!, far!));
  });

  it('detects a negated restatement as a contradiction', async () => {
    expect(await llm.compare('jag bor i Stockholm', 'jag bor inte i Stockholm')).toBe('contradicts');
    expect(await llm.compare('jag bor i Stockholm', 'jag bor i Stockholm')).toBe('same');
    expect(await llm.compare('jag bor i Stockholm', 'kvartalsrapport klar')).toBe('unrelated');
  });

  it('skips facts the room already knows', async () => {
    const facts = await llm.extractFacts({
      text: 'Allergisk mot ketchup. Dottern heter Vera.',
      existing: ['allergisk mot ketchup'],
    });
    expect(facts.map((f) => f.body)).toEqual(['Dottern heter Vera']);
  });

  it('honours the summary budget', async () => {
    const out = await llm.summarise({ texts: ['a'.repeat(100), 'b'.repeat(100)], budgetTokens: 20 });
    expect(out.length).toBeLessThanOrEqual(60);
  });
});
