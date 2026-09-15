import { describe, expect, it } from 'vitest';

import { swedishStem, swedishTerms } from './swedish.js';

describe('swedishStem', () => {
  it('strips a definite/genitive noun suffix down to the base form — the motivating case', () => {
    // "ledningen" not matching a room named "Ledning" was the reason PR #3's own
    // author flagged their hand-rolled suffix list for replacement.
    expect(swedishStem('ledningen')).toBe('ledning');
    expect(swedishStem('ledningens')).toBe('ledning');
    expect(swedishStem('Ledning')).toBe('ledning');
  });

  it('agrees with what Postgres\u2019 own swedish dictionary actually does, including its gaps', () => {
    // Checked directly against `to_tsvector('swedish', ...)` rather than assumed.
    // Postgres itself does not unify every tense/participle pair (e.g. "godkände" and
    // "godkänt" stay distinct there too) -- matching that real behaviour is the goal,
    // not an idealised stemmer that claims more than the canonical one delivers.
    const cases: Array<[string, string]> = [
      ['ansvarar', 'ansvar'],
      ['flyttar', 'flytt'],
      ['flytta', 'flytt'],
      ['använder', 'använd'],
      ['använda', 'använd'],
      ['uppdateringar', 'uppdatering'],
      ['uppdatering', 'uppdatering'],
      ['omsättningen', 'omsättning'],
      ['omsättning', 'omsättning'],
      ['lanserar', 'lanser'],
      ['lansera', 'lanser'],
      ['godkände', 'godkänd'],
    ];

    for (const [word, stem] of cases) {
      expect(swedishStem(word), word).toBe(stem);
    }
  });

  it('leaves an already-short or already-base word alone rather than over-stemming', () => {
    expect(swedishStem('rum')).toBe('rum');
    expect(swedishStem('bor')).toBe('bor');
    expect(swedishStem('hus')).toBe('hus');
  });

  it('is case-insensitive', () => {
    expect(swedishStem('BUYERSCLUB')).toBe(swedishStem('buyersclub'));
  });

  it('never returns something longer than it was given', () => {
    for (const word of ['ledningen', 'använder', 'a', 'xyz', 'överenskommelserna']) {
      expect(swedishStem(word).length).toBeLessThanOrEqual(word.length);
    }
  });
});

describe('swedishTerms', () => {
  it('tokenizes on punctuation and stems every token', () => {
    expect(swedishTerms('Vad bestämde vi om förvärvet?')).toEqual(
      ['vad', 'bestämde', 'vi', 'om', 'förvärvet'].map(swedishStem),
    );
  });

  it('splits a hyphenated compound into separate terms', () => {
    expect(swedishTerms('due diligence-paketet')).toContain(swedishStem('paketet'));
  });

  it('lets a question and its answer share a term after stemming when they would not share one raw', () => {
    const question = swedishTerms('Har styrelsen godkänt budgeten?');
    const answer = swedishTerms('Styrelsen godkände budgeten för nästa kvartal');
    // Not every pair unifies (see the Postgres-parity test above) -- "budgeten" and
    // "styrelsen" are the ones that do here, and they are enough to match on.
    expect(question).toContain(swedishStem('budgeten'));
    expect(answer).toContain(swedishStem('budgeten'));
    expect(question.some((t) => answer.includes(t))).toBe(true);
  });

  it('returns nothing for text with no letters or digits', () => {
    expect(swedishTerms('??? — !!!')).toEqual([]);
  });
});
