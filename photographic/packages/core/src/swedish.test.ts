/**
 * Every expected value in this file is a literal, and every literal was taken from
 * Postgres rather than from this module.
 *
 * That is not stylistic. Three cases here used to compute their expectation by calling
 * `swedishStem` on the way in — `expect(swedishTerms(s)).toEqual([...].map(swedishStem))`
 * and two `toContain(swedishStem(w))` — which means they asserted that the function
 * agrees with itself and would have passed for `x => x`. The whole reason this module
 * exists is that its output is what search quality is measured on, so a test that
 * cannot fail is worse here than no test: it reads as coverage of exactly the property
 * nothing else checks.
 *
 * The oracle is `to_tsvector('swedish', <word>)` on a real Postgres 16 — the canonical
 * Snowball Swedish implementation, and the same dictionary the SQL half of search uses.
 * Regenerate it with:
 *
 *   select w, to_tsvector('swedish', w) from unnest(ARRAY['ledningen']) as w;
 *
 * Where this module deliberately differs from that output, the difference is asserted
 * on purpose with Postgres's own answer named in the comment. A divergence nobody wrote
 * down is a divergence that gets "fixed" in the wrong direction later.
 */

import { describe, expect, it } from 'vitest';

import { swedishStem, swedishTerms } from './swedish.js';

describe('swedishStem', () => {
  it('strips a definite/genitive noun suffix down to the base form — the motivating case', () => {
    // "ledningen" not matching a room named "Ledning" was the reason PR #3's own
    // author flagged their hand-rolled suffix list for replacement.
    // Postgres: ledningen|ledning  ledningens|ledning  Ledning|ledning
    expect(swedishStem('ledningen')).toBe('ledning');
    expect(swedishStem('ledningens')).toBe('ledning');
    expect(swedishStem('Ledning')).toBe('ledning');
  });

  it('agrees with what Postgres\u2019 own swedish dictionary actually does, including its gaps', () => {
    // Every right-hand side is the lexeme `to_tsvector('swedish', <left>)` produced on
    // Postgres 16.15, copied across verbatim. Postgres itself does not unify every
    // tense/participle pair ("godkände" -> godkänd, but "godkänt" stays "godkänt"), and
    // it leaves a number of definite -et forms alone entirely ("förvärvet", "paketet",
    // "köket", "kontraktet"). Matching that real behaviour is the goal, not an
    // idealised stemmer that claims more than the canonical one delivers.
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
      ['godkänt', 'godkänt'],
      ['budgeten', 'budget'],
      ['marknadsföringsbudgeten', 'marknadsföringsbudget'],
      ['offerter', 'offert'],
      ['offert', 'offert'],
      ['leverantören', 'leverantör'],
      ['leverantörskontraktet', 'leverantörskontraktet'],
      ['kontraktet', 'kontraktet'],
      ['förvärvet', 'förvärvet'],
      ['förvärv', 'förvärv'],
      ['paketet', 'paketet'],
      ['köket', 'köket'],
      ['bestämde', 'bestämd'],
      ['nästa', 'näst'],
      ['kvartal', 'kvartal'],
      ['diligence', 'diligenc'],
      ['mars', 'mar'],
    ];

    for (const [word, stem] of cases) {
      expect(swedishStem(word), word).toBe(stem);
    }
  });

  it('leaves an already-short or already-base word alone rather than over-stemming', () => {
    // Postgres: rum|rum  bor|bor  hus|hus  kök|kök
    expect(swedishStem('rum')).toBe('rum');
    expect(swedishStem('bor')).toBe('bor');
    expect(swedishStem('hus')).toBe('hus');
    expect(swedishStem('kök')).toBe('kök');
  });

  it('is case-insensitive', () => {
    // Literal on both sides: comparing the two calls to each other would pass for any
    // function that happens to lowercase and do nothing else.
    expect(swedishStem('BUYERSCLUB')).toBe('buyersclub');
    expect(swedishStem('Ledningens')).toBe('ledning');
  });

  it('never returns something longer than it was given', () => {
    for (const word of ['ledningen', 'använder', 'a', 'xyz', 'överenskommelserna']) {
      expect(swedishStem(word).length).toBeLessThanOrEqual(word.length);
    }
  });

  it('stops short of Postgres on the step-3 adjective endings, which are not implemented', () => {
    // The documented scope of this module is Snowball steps 1 and 2. Step 3 deletes
    // "els"/"lig"/"ig", which is what takes Postgres the extra hop:
    //   Postgres: styrelsen|styr                    this module: styrels
    //   Postgres: överenskommelserna|överenskomm    this module: överenskommels
    //
    // Pinned rather than left implicit, because both forms still match each other,
    // which is all the product needs: "styrelsen" and "styrelsens" both reach
    // "styrels". If step 3 is ever added, these are the lines that should change — and
    // they should change to Postgres's answers, not to something new.
    expect(swedishStem('styrelsen')).toBe('styrels');
    expect(swedishStem('styrelsens')).toBe('styrels');
    expect(swedishStem('överenskommelserna')).toBe('överenskommels');
  });
});

describe('swedishTerms', () => {
  it('tokenizes on punctuation and stems every token', () => {
    // Literals, not `[...].map(swedishStem)`. Postgres's lexemes for the same sentence
    // are "bestämd" and "förvärvet" only — it drops "vad", "vi" and "om" as stopwords,
    // which this module deliberately does not do (see the stopword test below).
    expect(swedishTerms('Vad bestämde vi om förvärvet?')).toEqual([
      'vad',
      'bestämd',
      'vi',
      'om',
      'förvärvet',
    ]);
  });

  it('splits a hyphenated compound into separate terms', () => {
    // Postgres: due|due  diligence|diligenc  paketet|paketet
    expect(swedishTerms('due diligence-paketet')).toEqual(['due', 'diligenc', 'paketet']);
  });

  it('lets a question and its answer share a term after stemming when they would not share one raw', () => {
    // The pair that actually needed stemming here is "godkänt"/"godkände" — and it does
    // *not* unify, in this module or in Postgres. So the overlap has to come from
    // elsewhere, and it does: "budgeten" reaches "budget" from both sides, and
    // "styrelsen"/"Styrelsen" reach "styrels". Both sides are asserted as literals so
    // the shared terms are visible in the test rather than computed by the code under
    // test.
    expect(swedishTerms('Har styrelsen godkänt budgeten?')).toEqual([
      'har',
      'styrels',
      'godkänt',
      'budget',
    ]);
    expect(swedishTerms('Styrelsen godkände budgeten för nästa kvartal')).toEqual([
      'styrels',
      'godkänd',
      'budget',
      'för',
      'näst',
      'kvartal',
    ]);
  });

  it('keeps Swedish stopwords, unlike Postgres, because callers score a fraction of them', () => {
    // `to_tsvector('swedish', 'Har vi det för nästa kvartal')` is just "näst kvartal":
    // "har", "vi", "det" and "för" are in Postgres's swedish stopword list. This module
    // is a stemmer, not a stopword filter, and a caller that needs one brings its own
    // (see FUNCTION_WORDS in routing.ts, which drops connectives before scoring).
    // Asserted so that nobody "aligns this with Postgres" by quietly deleting terms a
    // caller is counting.
    expect(swedishTerms('Har vi det för nästa kvartal')).toEqual([
      'har',
      'vi',
      'det',
      'för',
      'näst',
      'kvartal',
    ]);
  });

  it('returns nothing for text with no letters or digits', () => {
    expect(swedishTerms('??? — !!!')).toEqual([]);
  });
});
