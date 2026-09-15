/**
 * Swedish mobile numbers, written the way people actually write them.
 *
 * A person types their own number the way they always have: `070-123 45 67` on a form,
 * `+46 70 123 45 67` from a contact card, ten digits in a row on a phone keypad. Those
 * are one number, so they are accepted as one number and stored as one E.164 string.
 * Nothing here rewrites the field as somebody types — correcting a person's own number
 * under their fingers is how a form starts feeling like it is arguing with them — so the
 * check runs on submit and the input keeps whatever they wrote.
 *
 * The series are PTS's, from the Swedish numbering plan (`nrplansammanstallning`,
 * 2026-05-18): 070, 072, 073, 076 and 079 are mobile telephony, and from 1 October 2026
 * so is 078 A where A is 0–2 or 4–9. 0783 is railway communication and the whole 074
 * series is paging; neither receives an SMS, so neither is a way in. The national
 * significant number is always nine digits.
 *
 * No imports on purpose. This module is the one piece of `@photographic/connect` the
 * browser bundle loads, so that the field and the endpoint agree on what a valid number
 * is instead of drifting apart in two suffix lists.
 */

/** How the number is shown back to a person, and the shape every message names. */
export const MOBILE_EXAMPLE = '070-123 45 67';

/** 07X XXX XX XX, minus the trunk zero. See the series note above. */
const MOBILE_SERIES = /^(?:7[02369]\d{7}|78[0-24-9]\d{6})$/;

/**
 * Everything a person might put between the digits: spaces of every width, the hyphen
 * and its typographic cousins, brackets, dots, slashes.
 */
const SEPARATORS = /[\s\u00a0\u202f()./\u002d\u2010-\u2015]/g;

export type PhoneProblem =
  | 'missing'
  | 'email'
  | 'characters'
  | 'country'
  | 'short'
  | 'long'
  | 'series';

export type PhoneCheck =
  | { ok: true; e164: string }
  | { ok: false; problem: PhoneProblem; message: string };

/**
 * One sentence per way a number can be wrong, because "ogiltigt telefonnummer" tells a
 * person nothing they can act on. Each of these names what is wrong and what right
 * looks like.
 */
const MESSAGES: Record<PhoneProblem, string> = {
  missing: 'Ange ditt mobilnummer.',
  email: `Koden kommer med SMS, så vi behöver ditt mobilnummer och inte en e-postadress. Skriv det som ${MOBILE_EXAMPLE}.`,
  characters: `Ett mobilnummer består av siffror. Skriv det som ${MOBILE_EXAMPLE}.`,
  country: 'Vi kan bara skicka koden till ett svenskt mobilnummer.',
  short: `Numret är för kort. Ett svenskt mobilnummer har tio siffror, som ${MOBILE_EXAMPLE}.`,
  long: `Numret är för långt. Ett svenskt mobilnummer har tio siffror, som ${MOBILE_EXAMPLE}.`,
  series:
    'Det ser inte ut som ett mobilnummer. Svenska mobilnummer börjar på 070, 072, 073, 076, 078 eller 079.',
};

function rejected(problem: PhoneProblem): PhoneCheck {
  return { ok: false, problem, message: MESSAGES[problem] };
}

/**
 * The national significant number, or `null` when the number belongs to another country.
 *
 * `+46`, `0046` and a bare `46` all mean Sweden. A trunk zero after the country code
 * (`+46 070 …`) is common enough on business cards to accept rather than reject.
 */
function nationalNumber(compact: string): string | null {
  const international = compact.startsWith('+')
    ? compact.slice(1)
    : compact.startsWith('00')
      ? compact.slice(2)
      : null;

  if (international !== null) {
    if (!international.startsWith('46')) return null;
    const rest = international.slice(2);
    return rest.startsWith('0') ? rest.slice(1) : rest;
  }

  if (compact.startsWith('0')) return compact.slice(1);
  // `46701234567`, pasted from somewhere that dropped the plus on the way.
  if (compact.startsWith('46') && compact.length === 11) return compact.slice(2);
  return compact;
}

/**
 * Reads a number the way a person wrote it and says either what it is or what is wrong
 * with it. Never throws: both answers are things the caller has to render.
 */
export function checkSwedishMobile(input: string): PhoneCheck {
  const trimmed = input.trim();
  if (!trimmed) return rejected('missing');
  // Checked before the character rule, so somebody who types an address is told that the
  // code arrives by SMS rather than that their address contains an illegal character.
  if (trimmed.includes('@')) return rejected('email');

  const compact = trimmed.replace(SEPARATORS, '');
  if (!/^\+?\d+$/.test(compact)) return rejected('characters');

  const national = nationalNumber(compact);
  if (national === null) return rejected('country');

  // Series before length: `08-123 45 67` is a landline, and being told it is too short
  // would send the person hunting for a missing digit.
  if (!national.startsWith('7')) return rejected('series');
  if (national.length < 9) return rejected('short');
  if (national.length > 9) return rejected('long');
  if (!MOBILE_SERIES.test(national)) return rejected('series');

  return { ok: true, e164: `+46${national}` };
}

/** `+46701234567` → `070-123 45 67`. The way the number is written in Sweden. */
export function formatSwedishMobile(e164: string): string {
  const national = e164.startsWith('+46') ? e164.slice(3) : null;
  if (national?.length !== 9) return e164;
  return `0${national.slice(0, 2)}-${national.slice(2, 5)} ${national.slice(5, 7)} ${national.slice(7)}`;
}

/**
 * `+46701234567` → `070-••• 45 67`.
 *
 * Enough for the person who just typed it to recognise their own number on the code
 * screen, and not enough to be worth reading over a shoulder.
 */
export function maskSwedishMobile(e164: string): string {
  const national = e164.startsWith('+46') ? e164.slice(3) : null;
  if (national?.length !== 9) return `***${e164.slice(-4)}`;
  return `0${national.slice(0, 2)}-••• ${national.slice(5, 7)} ${national.slice(7)}`;
}
