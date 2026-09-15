import { describe, expect, it } from 'vitest';

import { briefEventLine } from './brief-line.js';

describe('briefEventLine', () => {
  it('names the file a person uploaded', () => {
    expect(
      briefEventLine('document.uploaded', { filename: 'offert-kok.pdf', chunks: 4 }, 'Emil'),
    ).toBe('- Emil laddade upp offert-kok.pdf');
  });

  /**
   * The reason this file exists. `String(payload['filename'])` on a non-string produced
   * "[object Object]" in a person's own brief, in both implementations.
   */
  it('says "ett dokument" rather than [object Object] for a payload it cannot read', () => {
    for (const filename of [{ name: 'offert.pdf' }, ['offert.pdf'], 42, null, undefined, '   ']) {
      const line = briefEventLine('document.uploaded', { filename }, 'Emil');
      expect(line).toBe('- Emil laddade upp ett dokument');
      expect(line).not.toContain('object');
    }
  });

  it('quotes the body of a saved or changed memory, and skips one it cannot read', () => {
    expect(briefEventLine('item.created', { body: 'Allergisk mot selleri' }, 'Emil')).toBe(
      '- Emil sparade: Allergisk mot selleri',
    );
    expect(briefEventLine('item.updated', { body: 'Flyttat till 1 november' }, 'Emil')).toBe(
      '- Emil ändrade: Flyttat till 1 november',
    );
    expect(briefEventLine('item.created', { body: { text: 'nope' } }, 'Emil')).toBeNull();
  });

  it('does not name the memory it deleted', () => {
    // A deleted memory's text coming back through a brief is the leak the trash exists to
    // avoid making permanent.
    expect(briefEventLine('item.deleted', { body: 'Allergisk mot selleri' }, 'Emil')).toBe(
      '- Emil tog bort ett minne',
    );
  });

  it('falls back to "Någon" when the actor is unknown or blank', () => {
    expect(briefEventLine('member.joined', {}, null)).toBe('- Någon gick med i rummet');
    expect(briefEventLine('member.joined', {}, '  ')).toBe('- Någon gick med i rummet');
  });

  it('has nothing to say about an event type briefs do not summarise', () => {
    expect(briefEventLine('item.purged', { body: 'x' }, 'Emil')).toBeNull();
  });
});
