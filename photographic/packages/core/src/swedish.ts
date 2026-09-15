/**
 * A shared Swedish stemmer.
 *
 * This exists so there is one suffix list, not two hand-rolled ones drifting apart in
 * separate corners of the product — the automatic room-routing matcher and this
 * package's own lexical ranking arms both need "strip a Swedish inflection so
 * 'ledningen' matches 'Ledning'", and a second person independently guessing at
 * Swedish suffixes is exactly the failure this file is meant to close off.
 *
 * It implements the suffix-removal steps of the Swedish Snowball algorithm
 * (https://snowballstem.org/algorithms/swedish/stemmer.html) — the same algorithm
 * behind Postgres's own `to_tsvector('swedish', …)`, which is why this and the SQL
 * side of search agree on the cases that matter ("ledningen"/"ledningens" ->
 * "ledning") without one having to call out to the other to get there.
 *
 * Deliberately partial: steps 1 and 2 (the productive noun and verb inflection
 * endings — plurals, definite forms, tenses, genitives) are implemented in full, since
 * they cover the overwhelming majority of real mismatches. Step 3 (a handful of
 * adjective-specific rewrites: "fullt" -> "full", "-lig"/"-ig"/"-els" endings) is not —
 * Postgres's own dictionary does not apply it uniformly either in the cases checked
 * against it, and the productive endings are where the actual product cost is. A
 * partial stemmer that is honest about its scope is worth more than one that claims
 * parity it does not have.
 */

const VOWELS = new Set('aeiouyåäö'.split(''));

/** Consonants a step-1 's'-suffix may legally follow — see `stripStep1Suffix`. */
const VALID_S_ENDING = new Set('bcdfghjklmnoprtvy'.split(''));

/**
 * Longest match wins, so longer suffixes must be tried first — this is already sorted
 * that way and stays that way; do not append to the end without re-sorting.
 */
const STEP1_SUFFIXES = [
  'heterna',
  'hetens',
  'arnas',
  'ernas',
  'ornas',
  'andet',
  'anden',
  'heten',
  'heter',
  'arens',
  'arna',
  'erna',
  'orna',
  'ade',
  'are',
  'aste',
  'arne',
  'aren',
  'ades',
  'andes',
  'erns',
  'en',
  'ar',
  'er',
  'or',
  'ad',
  'as',
  'es',
  'at',
  'ens',
  'ern',
  'het',
  'ast',
  'a',
  'e',
  's',
].sort((a, b) => b.length - a.length);

const STEP2_SUFFIXES = ['dd', 'gd', 'nn', 'dt', 'gt', 'kt', 'tt'];

/**
 * The R1 region: everything after the first non-vowel that follows a vowel, with a
 * minimum offset of 3 — the Snowball algorithm's way of refusing to touch a word too
 * short to have a real suffix. Suffix removal is only ever applied within R1, which is
 * what stops this from mangling short, already-base-form words.
 */
function r1Start(word: string): number {
  for (let i = 1; i < word.length; i += 1) {
    if (VOWELS.has(word[i - 1]!) && !VOWELS.has(word[i]!)) {
      return Math.max(i + 1, 3);
    }
  }
  return word.length;
}

/** One word, lowercased, to its stem. Anything shorter than R1 allows is returned as-is. */
export function swedishStem(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length < 3) return lower;

  const r1 = r1Start(lower);
  const afterStep1 = stripStep1Suffix(lower, r1);
  return stripStep2Suffix(afterStep1, r1);
}

function stripStep1Suffix(word: string, r1: number): string {
  for (const suffix of STEP1_SUFFIXES) {
    if (!word.endsWith(suffix)) continue;
    const cut = word.length - suffix.length;
    if (cut < r1) continue;

    // An 's'-initial suffix only comes off when the letter it would leave exposed is
    // one of a fixed set of consonants — otherwise "removing the s" would just be
    // removing a letter that was never part of an inflection.
    if (suffix.startsWith('s')) {
      const precedingChar = word[cut - 1];
      if (!precedingChar || !VALID_S_ENDING.has(precedingChar)) continue;
    }

    return word.slice(0, cut);
  }
  return word;
}

function stripStep2Suffix(word: string, r1: number): string {
  for (const suffix of STEP2_SUFFIXES) {
    if (!word.endsWith(suffix)) continue;
    // The whole two-letter suffix has to lie within R1, same rule as step 1 -- not
    // just the single letter this step goes on to delete.
    if (word.length - suffix.length < r1) continue;
    return word.slice(0, word.length - 1);
  }
  return word;
}

/**
 * A sentence, tokenized and stemmed — the practical entry point for "does this text
 * match that text, allowing for Swedish inflection". Splits on anything that is not a
 * letter or digit (so "Buyersclub Ledning" and "due diligence-paketet" tokenize the
 * way a person would expect), lowercases, and stems each token, dropping anything
 * that stems to nothing.
 */
export function swedishTerms(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean)
    .map(swedishStem)
    .filter(Boolean);
}
