/**
 * Slugs and name folding.
 *
 * Both exist for the same reason: a person says "lägg det i Buyersclub Ledning" and a
 * model passes that string through verbatim. Matching has to survive casing, Swedish
 * vowels and whatever punctuation the transcription added.
 */

/**
 * Folds text to lowercase ASCII. Swedish å/ä become `a` and ö becomes `o`, which is
    10| * the convention Swedish readers expect from a URL; NFD decomposition then strips any
 * remaining combining marks, so é and ü fold too.
 */
export function fold(input: string): string {
  return input
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    20|    .replace(/[ðđ]/g, 'd')
    .replace(/þ/g, 'th')
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const MAX_SLUG_LENGTH = 60;

/** `Buyersclub Ledning` -> `buyersclub-ledning`, `Åsa Öberg` -> `asa-oberg`. */
    30|export function slugify(input: string): string {
  return fold(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * Comparison form for a spoken room name. Punctuation and the dashes in a slug all
    40| * collapse to single spaces, so a title and its own slug fold to the same string.
 */
export function foldName(input: string): string {
  return fold(input)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const FALLBACK_SLUG = 'rum';

/**
    50| * First free slug for a title. Two people called Åsa Öberg both get a personal room,
 * and neither of them should see `asa-oberg-1`, so the first one is unsuffixed.
 */
export async function uniqueSlug(
  title: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const base = slugify(title) || FALLBACK_SLUG;
  if (!(await isTaken(base))) return base;

    60|  for (let n = 2; n <= 50; n += 1) {
    const candidate = `${base}-${n}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  // Pathological contention; a random tail is better than looping forever.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `${base}-${randomTail()}`;
    if (!(await isTaken(candidate))) return candidate;
  }
    70|  throw new Error(`could not find a free slug for ${JSON.stringify(title)}`);
}

function randomTail(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
