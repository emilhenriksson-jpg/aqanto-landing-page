/**
 * The copy, asserted as copy.
 *
 * This is the first thing anyone who is not Emil sees of the product, so the tone rules
 * in `DESIGN.md` are worth holding to mechanically: no exclamation marks, no chirpiness,
 * one violet and nothing else with colour.
 */

import { describe, expect, it } from 'vitest';

import { CODE_TTL_MINUTES, codeEmail, codeMessageFor, codeSms } from './message.js';

describe('the email', () => {
  it('puts the code in the subject, where a phone notification will show it', () => {
    expect(codeEmail({ code: '424242' }).subject).toBe('424242 är din kod till Photographic');
  });

  it('carries the code and its lifetime in both parts', () => {
    const message = codeEmail({ code: '424242' });

    for (const part of [message.text, message.html]) {
      expect(part).toContain('424242');
      expect(part).toContain(`${CODE_TTL_MINUTES} minuter`);
    }
  });

  it('tells someone who did not ask for it that they need do nothing', () => {
    // The line that stops a misdirected code becoming alarming, and the only honest
    // thing to say: the code is useless without the browser that requested it.
    expect(codeEmail({ code: '424242' }).text).toContain('Bad du inte om att logga in?');
  });

  it('says it once, plainly', () => {
    const { subject, text } = codeEmail({ code: '424242' });

    expect(subject).not.toContain('!');
    expect(text).not.toContain('!');
    // No assistant chirpiness, and no marketing.
    expect(text.toLowerCase()).not.toMatch(/välkommen|grattis|tack för|kom igång nu/);
  });

  it('uses one accent and no other colour', () => {
    const html = codeEmail({ code: '424242' }).html;
    const colours = new Set(html.match(/#[0-9a-f]{6}/gi)?.map((c) => c.toLowerCase()) ?? []);

    // The brand violet, and otherwise only the canvas/surface/ink greys from DESIGN.md.
    expect(colours).toContain('#5433eb');
    expect([...colours].filter((c) => !['#5433eb', '#f2f4f5', '#ffffff', '#0a0a0a', '#6b7280'].includes(c))).toEqual([]);
  });

  it('escapes the code rather than trusting it into markup', () => {
    // The code is generated, not user input — but this is a template rendering a value
    // into HTML, and the next value rendered here will not be.
    expect(codeEmail({ code: '<script>' }).html).toContain('&lt;script&gt;');
    expect(codeEmail({ code: '<script>' }).html).not.toContain('<script>');
  });

  it('honours a different lifetime', () => {
    expect(codeEmail({ code: '1', ttlMinutes: 3 }).text).toContain('3 minuter');
  });
});

describe('the sms', () => {
  it('is one line with the code and the lifetime', () => {
    const message = codeSms({ code: '424242' });

    expect(message).toBe('424242 är din kod till Photographic. Gäller i 10 minuter.');
    expect(message).not.toContain('\n');
  });
});

describe('codeMessageFor', () => {
  it('picks by channel', () => {
    expect(typeof codeMessageFor('sms', { code: '1' })).toBe('string');
    expect(codeMessageFor('email', { code: '1' })).toHaveProperty('subject');
  });
});
