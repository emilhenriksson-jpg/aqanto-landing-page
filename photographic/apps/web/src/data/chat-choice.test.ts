import { afterEach, expect, it } from 'vitest';
import { lastChatChoice } from './chat-choice.js';

afterEach(() => localStorage.clear());
it('ignores stale or unsupported saved choices', () => {
  for (const value of ['vscode', 'removed-client', '{"id":"claude"}', 'https://example.com']) {
    localStorage.setItem('photographic.chat-choice.v1', value);
    expect(lastChatChoice()).toBeNull();
  }
});
