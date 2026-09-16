import { describe, expect, it } from 'vitest';
import { buildClients, CHAT_START_PROMPT } from './clients.js';

describe('room-independent chat launch', () => {
  const clients = buildClients({ mcpUrl: 'https://memory.example/mcp', connectPageUrl: 'https://memory.example/connect' });
  it('separates setup from launch and exposes exactly the four requested clients', () => {
    expect(clients.filter((client) => client.launch).map((client) => client.id).sort())
      .toEqual(['chatgpt', 'claude', 'codex', 'cursor']);
    for (const client of clients.filter((entry) => entry.launch)) {
      expect(client.launch?.prompt).toBe(CHAT_START_PROMPT);
      expect(client.launch?.url).not.toContain('memory.example');
      expect(client.launch?.url).not.toMatch(/token=|room=|person=/);
    }
  });
  it('uses documented prompt parameters with a lossless Unicode round trip', () => {
    for (const [id, scheme, parameter] of [['codex', 'codex:', 'prompt'], ['cursor', 'cursor:', 'text'], ['claude', 'claude:', 'q']]) {
      const launch = clients.find((client) => client.id === id)!.launch!;
      const url = new URL(launch.url);
      expect(url.protocol).toBe(scheme);
      expect(url.searchParams.get(parameter!)).toBe(CHAT_START_PROMPT);
      expect(launch.url.length).toBeLessThan(8000);
      expect(url.searchParams.has('submit')).toBe(false);
    }
  });
  it('does not promise to attach an unpublished ChatGPT connector from a URL', () => {
    const chatgpt = clients.find((client) => client.id === 'chatgpt')!;
    expect(chatgpt.launch?.url).toBe('https://chatgpt.com/');
    expect(chatgpt.launch?.note).toContain('verktygsmeny');
  });
});
