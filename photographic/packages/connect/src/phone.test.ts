import { describe, expect, it } from 'vitest';

import {
  checkSwedishMobile,
  formatSwedishMobile,
  maskSwedishMobile,
  MOBILE_EXAMPLE,
} from './phone.js';

/** The E.164 string, or the assertion fails saying which problem came back instead. */
function e164(input: string): string {
  const checked = checkSwedishMobile(input);
  if (!checked.ok) throw new Error(`${input} avvisades: ${checked.problem}`);
  return checked.e164;
}

function problem(input: string): string {
  const checked = checkSwedishMobile(input);
  if (checked.ok) throw new Error(`${input} godtogs, väntade ett fel`);
  return checked.problem;
}

describe('reading a number a person wrote', () => {
  it('treats the four common shapes as one number', () => {
    for (const written of ['070-123 45 67', '0701234567', '+46 70 123 45 67', '+46701234567']) {
      expect(e164(written)).toBe('+46701234567');
    }
  });

  it('accepts the other ways the same number turns up', () => {
    const same = [
      '070 123 45 67',
      '070.123.45.67',
      '(070) 123 45 67',
      '070–123 45 67', // en dash, which is what a word processor leaves behind
      '  070-1234567  ',
      '0046701234567',
      '0046 (0)70 123 45 67',
      '+46 (0)70-123 45 67',
      '46701234567',
      '701234567',
      '070\u00a0123\u00a045\u00a067', // non-breaking spaces, pasted from a web page
    ];

    for (const written of same) {
      expect(e164(written)).toBe('+46701234567');
    }
  });

  it('accepts every mobile series PTS has allocated', () => {
    // 070, 072, 073, 076 and 079, plus 078 A from 1 October 2026. Getting this list wrong
    // in either direction is somebody unable to sign up with the number they own.
    expect(e164('070-123 45 67')).toBe('+46701234567');
    expect(e164('072-123 45 67')).toBe('+46721234567');
    expect(e164('073-123 45 67')).toBe('+46731234567');
    expect(e164('076-123 45 67')).toBe('+46761234567');
    expect(e164('079-123 45 67')).toBe('+46791234567');
    expect(e164('078-023 45 67')).toBe('+46780234567');
    expect(e164('078-923 45 67')).toBe('+46789234567');
  });

  it('turns down the 07 numbers that cannot receive an SMS', () => {
    // 074 is paging and 0783 is railway communication; 071 0 is mobile broadband. A code
    // sent to any of them is a code nobody reads.
    expect(problem('074-123 45 67')).toBe('series');
    expect(problem('078-323 45 67')).toBe('series');
    expect(problem('071-023 45 67')).toBe('series');
  });
});

describe('saying what is wrong', () => {
  it('names each way a number can be wrong', () => {
    expect(problem('')).toBe('missing');
    expect(problem('   ')).toBe('missing');
    expect(problem('emil@example.com')).toBe('email');
    expect(problem('sju noll ett')).toBe('characters');
    expect(problem('+47 900 12 345')).toBe('country');
    expect(problem('0047 900 12 345')).toBe('country');
    expect(problem('070-123 45')).toBe('short');
    expect(problem('070-123 45 67 8')).toBe('long');
    expect(problem('08-123 45 67')).toBe('series');
  });

  it('calls a landline a landline rather than a number of the wrong length', () => {
    // `08-123 45 67` is one digit short of a mobile number, and being told so would send
    // the person hunting for a digit that was never missing.
    expect(problem('08-123 45 67')).toBe('series');
    expect(problem('031-12 34 56')).toBe('series');
  });

  it('tells someone who typed an address that the code comes by SMS', () => {
    const checked = checkSwedishMobile('emil@example.com');
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.message).toContain('SMS');
  });

  it('shows the shape it wants in every message that has room for one', () => {
    for (const input of ['abc', '+46 70 12', '070-123 45 67 89', 'emil@example.com']) {
      const checked = checkSwedishMobile(input);
      expect(checked.ok).toBe(false);
      if (checked.ok) return;
      expect(checked.message).toContain(MOBILE_EXAMPLE);
    }
  });

  it('never throws, whatever it is handed', () => {
    for (const input of ['', '+', '++46', '0', '00', '46', '\u00a0', '070-123-45-67-89-01']) {
      expect(() => checkSwedishMobile(input)).not.toThrow();
    }
  });
});

describe('showing a number back', () => {
  it('writes it the Swedish way', () => {
    expect(formatSwedishMobile('+46701234567')).toBe('070-123 45 67');
    expect(formatSwedishMobile('+46789234567')).toBe('078-923 45 67');
  });

  it('masks the middle and keeps the ends recognisable', () => {
    expect(maskSwedishMobile('+46701234567')).toBe('070-••• 45 67');
    expect(maskSwedishMobile('+46701234567')).not.toContain('123');
  });

  it('falls back rather than mangling something that is not a Swedish mobile', () => {
    // The email channel still exists in the domain, so this function can still be handed
    // a destination it did not shape.
    expect(maskSwedishMobile('+4790012345')).toBe('***2345');
    expect(formatSwedishMobile('+4790012345')).toBe('+4790012345');
  });
});
