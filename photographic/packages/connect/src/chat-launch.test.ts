import { describe, expect, it } from 'vitest';
import { buildClients, chatLaunch, CHAT_START_PROMPT } from './clients.js';

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
      const url = new URL(launch.url!);
      expect(url.protocol).toBe(scheme);
      expect(url.searchParams.get(parameter!)).toBe(CHAT_START_PROMPT);
      expect(launch.url!.length).toBeLessThan(8000);
      expect(url.searchParams.has('submit')).toBe(false);
    }
  });
  it.each(['macos', 'windows', 'linux', 'unknown'] as const)('selects ChatGPT or Codex explicitly without a project on %s', (platform) => {
    for (const [id, mode] of [['chatgpt', 'chat'], ['codex', 'codex']] as const) {
      const url = new URL(chatLaunch(id, platform)!.url!);
      expect(url.protocol + '//' + url.host + url.pathname).toBe('codex://threads/new');
      expect(url.searchParams.getAll('mode')).toEqual([mode]);
      expect(url.searchParams.get('prompt')).toBe(CHAT_START_PROMPT);
      // No current project, workspace or automatic submission travels with the link.
      expect([...url.searchParams.keys()].sort()).toEqual(['mode', 'prompt']);
    }
  });
  it.each(['ios', 'android'] as const)('does not offer desktop-only launches on %s', (platform) => {
    expect(chatLaunch('codex', platform)?.url).toBeNull();
    expect(chatLaunch('cursor', platform)?.url).toBeNull();
    for (const id of ['chatgpt', 'claude'] as const) {
      const launch = chatLaunch(id, platform)!;
      expect(launch.url).not.toMatch(/^(codex|cursor|claude):/);
      expect(launch.url).not.toContain('browser_fallback_url');
      expect(launch.desktop).toBe(false);
      expect(launch.copyPromptOnOpen).toBe(true);
    }
  });
  it('uses associated iOS chat routes, not a desktop site or Claude Code', () => {
    const chatgpt = new URL(chatLaunch('chatgpt', 'ios')!.url!);
    expect(chatgpt.origin + chatgpt.pathname).toBe('https://chatgpt.com/');
    expect(chatgpt.searchParams.get('q')).toBe(CHAT_START_PROMPT);
    expect(chatLaunch('claude', 'ios')!.url).toBe('https://claude.ai/new');
  });
  it('targets the official Android packages without automatic browser fallback', () => {
    expect(chatLaunch('chatgpt', 'android')!.url).toContain('#Intent;scheme=https;package=com.openai.chatgpt;end');
    expect(chatLaunch('claude', 'android')!.url).toBe('intent://claude.ai/new#Intent;scheme=https;package=com.anthropic.claude;end');
  });
  it('does not promise to attach an unpublished ChatGPT connector from a URL', () => {
    const chatgpt = clients.find((client) => client.id === 'chatgpt')!;
    expect(new URL(chatgpt.launch!.url!).searchParams.get('mode')).toBe('chat');
    expect(chatgpt.launch?.fallbackUrl).toBe('https://chatgpt.com/?no_universal_links=1');
    expect(chatgpt.launch?.note).toContain('verktygsmeny');
  });
});
