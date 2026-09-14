import { describe, expect, it } from 'vitest';

import { classify, detectSource, previewImport } from './import.js';

/** Roughly what selecting ChatGPT's memory list and pressing copy produces. */
const CHATGPT_PASTE = `Saved memories
Manage memories

- User is allergic to ketchup
- The user's daughter is named Vera
- User prefers concise answers without preamble
- Always challenge the user's ideas rather than agreeing
- User lives in Stockholm and works as a CEO
- Never use emoji in responses
- User is allergic to ketchup
- ok
Delete all`;

describe('parsing a ChatGPT paste', () => {
  const result = previewImport(CHATGPT_PASTE);
  const texts = result.candidates.map((c) => c.text);

  it('recognises where the paste came from', () => {
    expect(result.source).toBe('chatgpt');
    expect(detectSource('bara en lista')).toBe('other');
  });

  it('drops the settings chrome', () => {
    expect(texts).not.toContain('Saved memories');
    expect(texts).not.toContain('Delete all');
    expect(result.skipped.filter((s) => s.reason === 'chrome').length).toBeGreaterThan(2);
  });

  it('rewrites third-person framing into the person\u2019s own voice', () => {
    expect(texts).toContain('Allergic to ketchup');
    expect(texts).toContain('Daughter is named Vera');
    // Every memory in Photographic reads as the person would say it about themselves.
    expect(texts.every((t) => !/^(the )?user/i.test(t))).toBe(true);
  });

  it('keeps the original wording so the review screen can show both', () => {
    const rewritten = result.candidates.find((c) => c.text === 'Allergic to ketchup');
    expect(rewritten?.original).toBe('User is allergic to ketchup');
  });

  it('drops an exact duplicate without dropping the first one', () => {
    expect(texts.filter((t) => t === 'Allergic to ketchup')).toHaveLength(1);
    expect(result.skipped.some((s) => s.reason === 'duplicate')).toBe(true);
  });

  it('drops lines too short to be a memory', () => {
    expect(texts).not.toContain('ok');
    expect(result.skipped.some((s) => s.reason === 'too_short' && s.text === 'ok')).toBe(true);
  });

  it('accounts for every line, so nothing vanishes silently', () => {
    const lines = CHATGPT_PASTE.split('\n').filter((l) => l.trim().length > 0);
    expect(result.candidates.length + result.skipped.length).toBe(lines.length);
  });
});

describe('classification', () => {
  it('treats imperative phrasing as an instruction', () => {
    expect(classify('Always challenge my ideas')).toBe('instruction');
    expect(classify('Svara alltid på svenska')).toBe('instruction');
  });

  it('treats a prohibition as never', () => {
    expect(classify('Never use emoji in responses')).toBe('never');
  });

  it('separates a preference from an instruction', () => {
    expect(classify('Likes dark roast coffee')).toBe('preference');
  });

  it('spots identity lines', () => {
    expect(classify('Lives in Stockholm')).toBe('identity');
    expect(classify('Heter Emil')).toBe('identity');
  });

  it('falls back to fact', () => {
    expect(classify('Allergic to ketchup')).toBe('fact');
  });
});

describe('what needs a human before it counts', () => {
  const result = previewImport(CHATGPT_PASTE);

  it('holds instructions and prohibitions behind an explicit yes', () => {
    for (const candidate of result.candidates) {
      const expected = candidate.kind === 'instruction' || candidate.kind === 'never';
      expect(candidate.needsApproval, candidate.text).toBe(expected);
    }
  });

  it('lets plain facts through a bulk approve', () => {
    const fact = result.candidates.find((c) => c.text === 'Allergic to ketchup');
    expect(fact?.needsApproval).toBe(false);
  });

  it('never writes anything by itself', () => {
    // The whole function is pure: importing another system's extracted memories
    // silently means inheriting its mistakes.
    expect(Object.keys(result).sort()).toEqual(['candidates', 'skipped', 'source']);
  });
});

describe('secrets', () => {
  it('refuses an API key and does not echo it back', () => {
    const result = previewImport('- My api key: sk-abc123def456\n- Allergic to ketchup');

    expect(result.candidates.map((c) => c.text)).toEqual(['Allergic to ketchup']);
    const skipped = result.skipped.find((s) => s.reason === 'secret');
    expect(skipped?.text).toBe('[utelämnat]');
    expect(JSON.stringify(result)).not.toContain('sk-abc123def456');
  });

  it('refuses a card number', () => {
    const result = previewImport('- 4111 1111 1111 1111\n- Bor i Stockholm');
    expect(result.candidates).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('4111');
  });
});

describe('robustness', () => {
  it('handles an empty paste', () => {
    expect(previewImport('')).toMatchObject({ candidates: [], skipped: [] });
  });

  it('handles a paste with no line breaks but inline bullets', () => {
    const result = previewImport(
      'Allergisk mot ketchup \u2022 Dottern heter Vera \u2022 Bor i Stockholm',
    );
    expect(result.candidates).toHaveLength(3);
  });

  it('handles numbered and checkbox lists', () => {
    const result = previewImport('1. Allergisk mot ketchup\n2) Dottern heter Vera\n[x] Bor i Stockholm');
    expect(result.candidates.map((c) => c.text)).toEqual([
      'Allergisk mot ketchup',
      'Dottern heter Vera',
      'Bor i Stockholm',
    ]);
  });

  it('drops something long enough to be a document rather than a memory', () => {
    const result = previewImport(`- ${'x'.repeat(500)}`);
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('too_long');
  });

  it('strips hedged reporting down to the fact itself', () => {
    const result = previewImport('- User mentioned that he is allergic to ketchup');
    expect(result.candidates[0]?.text).toBe('Allergic to ketchup');
  });

  it('keeps a possessive subject rather than mangling it', () => {
    const result = previewImport("- The user's daughter is named Vera");
    expect(result.candidates[0]?.text).toBe('Daughter is named Vera');
  });
});
