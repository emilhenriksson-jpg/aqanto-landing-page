/**
 * The Personal Compass: six fixed principles for how a model should treat this person,
 * delivered at session start rather than fetched, and changed only through the same
 * approval gate as any other instruction.
 *
 * The set of *slots* is fixed and lives here, in code — not in the database, and not
 * open-ended. A person does not add a seventh principle; they replace the wording of one
 * of the six. That is what keeps this a compass rather than a second `instruction` kind
 * with extra ceremony: a model can hold six distinct axes in mind against every answer,
 * which is the whole reason a curated list beats a long one. See
 * docs/agent-instruction-layer.md for the reasoning behind exactly these six.
 *
 * A principle nobody has customised yet renders its default text with no memory behind
 * it — no item, no `created` event, nothing in the calendar claiming the person said it.
 * The default lives here in code for exactly that reason: it lets a first session avoid
 * sounding generic without ever fabricating a decision the person never made. The
 * instant a principle is changed, that becomes a real memory with real provenance, and
 * the built-in default for that slot is gone for good.
 */

import type { ShortId } from './domain.js';

export type CompassPrincipleKey =
  | 'directness'
  | 'no_performative_encouragement'
  | 'independent_conclusions'
  | 'challenge_weak_arguments'
  | 'lead_with_problems'
  | 'label_certainty';

export interface CompassPrincipleDef {
  key: CompassPrincipleKey;
  /** Short Swedish label, for surfaces that list all six (the compass screen). */
  label: string;
  /** Rendered verbatim when nobody has customised this principle. */
  defaultText: string;
}

/**
 * Order matters for two reasons: it is the order every session reads them in, and it is
 * the order the compass screen lists them in. Directness first because it is the
 * principle every other one assumes — a model that is not direct will soften the other
 * five on the way out regardless of what they say.
 */
export const COMPASS_PRINCIPLES: readonly CompassPrincipleDef[] = [
  {
    key: 'directness',
    label: 'Var varm och tydlig',
    defaultText: 'Var varm och tydlig. Prata vardagligt, som en bekant som lyssnar.',
  },
  {
    key: 'no_performative_encouragement',
    label: 'Visa omtanke utan tomt beröm',
    defaultText:
      'Visa omtanke utan tomt beröm. Bekräfta känslan utan att automatiskt hålla med.',
  },
  {
    key: 'independent_conclusions',
    label: 'Bilda din egen uppfattning',
    defaultText:
      'Ha en egen uppfattning och säg ärligt vad du tror.',
  },
  {
    key: 'challenge_weak_arguments',
    label: 'Utmana när det hjälper',
    defaultText:
      'Utmana varsamt när det hjälper. Ett vardagligt samtal behöver ingen granskning.',
  },
  {
    key: 'lead_with_problems',
    label: 'Ta viktiga problem på allvar',
    defaultText:
      'Var tydlig med viktiga problem. Lyssna först när personen behöver stöd, inte råd.',
  },
  {
    key: 'label_certainty',
    label: 'Skilj fakta, antagande och spekulation',
    defaultText: 'Skilj på vad som är fakta, vad som är ett antagande och vad som är spekulation.',
  },
];

const KEYS = new Set<string>(COMPASS_PRINCIPLES.map((p) => p.key));

export function isCompassPrincipleKey(value: unknown): value is CompassPrincipleKey {
  return typeof value === 'string' && KEYS.has(value);
}

export function compassPrincipleLabel(key: CompassPrincipleKey): string {
  return COMPASS_PRINCIPLES.find((p) => p.key === key)?.label ?? key;
}

/** The JSON field name a compass item's `structured` column carries its slot under. */
export const COMPASS_KEY_FIELD = 'compassKey';

/** One principle as it renders for a person: either their own wording or the default. */
export interface CompassEntry {
  key: CompassPrincipleKey;
  text: string;
  source: 'default' | 'personal';
  /** Set only when `source` is `'personal'` — there is nothing to reference for a default. */
  shortId: ShortId | null;
}

/**
 * Builds the six-entry compass from whatever compass-kind items exist, filling any gap
 * with the built-in default.
 *
 * Takes the loosely-typed shape rather than a full `Item`, so both `MemoryProjection` and
 * `PgProjection` can call this with whatever they already have in hand without an extra
 * mapping step. Only the fields the compass actually needs.
 */
export function compassEntriesFrom(
  items: ReadonlyArray<{ shortId: ShortId; body: string; structured: Record<string, unknown> }>,
): CompassEntry[] {
  const byKey = new Map<CompassPrincipleKey, { shortId: ShortId; body: string }>();

  for (const item of items) {
    const key = item.structured[COMPASS_KEY_FIELD];
    if (isCompassPrincipleKey(key) && !byKey.has(key)) {
      byKey.set(key, { shortId: item.shortId, body: item.body });
    }
  }

  return COMPASS_PRINCIPLES.map((def) => {
    const custom = byKey.get(def.key);
    return custom
      ? { key: def.key, text: custom.body, source: 'personal' as const, shortId: custom.shortId }
      : { key: def.key, text: def.defaultText, source: 'default' as const, shortId: null };
  });
}

/**
 * The same six, rebuilt from a *cached* compass rather than from items.
 *
 * `app.profile.compass` is a cache of what `compassEntriesFrom` computed, and a profile
 * row written before `0015_personal_compass.sql` holds the column default `'[]'`. Read
 * back literally, that delivered a person no compass at all — so whether the whole
 * block reached a model depended on when the account was created and whether anything
 * had happened to rebuild the projection since. An account that never touched a
 * principle must never look like it made a choice, and must never look blank either;
 * both halves of that are properties of the code, not of a rebuild having run.
 *
 * So the fallback happens here, on every read, rather than by treating a short array as
 * a cache miss and writing a fresh projection from inside a getter:
 *
 *  - a cached entry counts only when it says `personal`, names one of the six keys and
 *    carries text. That is the only shape that represents a decision somebody made.
 *  - every other slot renders the built-in default from `COMPASS_PRINCIPLES`, read live.
 *    A cached `default` is deliberately ignored: it is not a choice, it is a copy of
 *    code from the day the projection was last built, and rendering the stale copy is
 *    how an edit to a default text silently fails to reach existing accounts.
 *  - the result is always exactly six, in `COMPASS_PRINCIPLES` order, whatever the cache
 *    holds — `[]`, a partial write, an unknown key from a future version, or all six.
 */
export function compassEntriesFromCache(
  cached: ReadonlyArray<Partial<CompassEntry>> | null | undefined,
): CompassEntry[] {
  const personal = new Map<CompassPrincipleKey, { text: string; shortId: ShortId | null }>();

  // The guard is worth keeping — this is JSON out of a projection, so the declared type is
  // a claim about untrusted data rather than a guarantee. It needs the annotation because
  // `Array.isArray` narrows a `ReadonlyArray<T>` to `any[]`, which erases the element type
  // and makes every access below unchecked.
  const entries: ReadonlyArray<Partial<CompassEntry>> = Array.isArray(cached) ? cached : [];

  for (const entry of entries) {
    const key = entry?.key;
    const text = entry?.text?.trim();
    if (entry?.source !== 'personal' || !isCompassPrincipleKey(key) || !text) continue;
    if (!personal.has(key)) personal.set(key, { text, shortId: entry.shortId ?? null });
  }

  return COMPASS_PRINCIPLES.map((def) => {
    const own = personal.get(def.key);
    return own
      ? { key: def.key, text: own.text, source: 'personal' as const, shortId: own.shortId }
      : { key: def.key, text: def.defaultText, source: 'default' as const, shortId: null };
  });
}
