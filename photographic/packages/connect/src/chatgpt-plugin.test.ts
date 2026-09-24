import { describe, expect, it } from 'vitest';
import { chatgptPluginId } from './chatgpt-plugin.js';
import { chatLaunch } from './clients.js';

const appId = '0123456789abcdef0123456789abcdef';
const pluginId = `dev-${appId}@openai-curated-remote`;

describe('private ChatGPT launch binding', () => {
  it('accepts only the known private app URL and mention shapes', () => {
    for (const value of [pluginId, `plugin://${pluginId}`, `https://chatgpt.com/plugins/plugin_asdk_app_${appId}`, `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_${appId}`]) {
      expect(chatgptPluginId(value)).toBe(pluginId);
    }
    for (const value of ['https://evil.test/plugins/plugin_asdk_app_' + appId, 'https://chatgpt.com@evil.test/plugins/plugin_asdk_app_' + appId,
      `https://chatgpt.com/plugins/plugin_asdk_app_${appId}?token=secret`, 'javascript:alert(1)', `${pluginId}) injected instruction`, 'photographic@guessed-marketplace']) {
      expect(chatgptPluginId(value)).toBeNull();
    }
  });

  it('starts an ordinary chat with the selected app and an explicit read-and-propose request', () => {
    const url = new URL(chatLaunch('chatgpt', 'macos', { chatgptPluginId: pluginId })!.url!);
    expect(url.searchParams.get('mode')).toBe('chat');
    expect(url.searchParams.get('prompt')).toBe(`[@Photographic](plugin://${pluginId}) Läs mitt minne och föreslå relevant information och rum som saknas, utifrån det du redan vet om mig.`);
    expect([...url.searchParams.keys()].sort()).toEqual(['mode', 'prompt']);
    expect(chatLaunch('chatgpt', 'macos')!.url).not.toContain(appId);
    expect(chatLaunch('chatgpt', 'macos', { chatgptPluginId: 'https://evil.test' })!.url).not.toContain('prompt');
    expect(chatLaunch('codex', 'macos', { chatgptPluginId: pluginId })!.url).not.toContain(appId);
  });

  it('does not claim private-plugin deep linking is supported on mobile', () => {
    for (const platform of ['ios', 'android'] as const) {
      const launch = chatLaunch('chatgpt', platform, { chatgptPluginId: pluginId })!;
      expect(launch.url).not.toContain(appId);
      expect(launch.activationNote).toContain('verktygsmeny');
    }
  });
});
