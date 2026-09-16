import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './return-path.js';
describe('return path', () => {
  it.each(['//evil.test', '/\\evil.test', '/\n/evil.test', 'https://evil.test', null])('refuses external redirects: %s', value => {
    expect(safeReturnTo(value)).toBeUndefined();
  });
  it('preserves a local deep link', () => {
    expect(safeReturnTo('/rum?id=123#minne')).toBe('/rum?id=123#minne');
  });
});
