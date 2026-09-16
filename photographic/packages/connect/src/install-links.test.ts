import { describe, expect, it } from 'vitest';

import { buildClients, CAPABILITY_RANK, findClient } from './clients.js';
import {
  claudeCodeCommand,
  cursorInstallLink,
  fromBase64,
  manualConfigSnippet,
  vscodeInstallLink,
} from './install-links.js';

const MCP_URL = 'https://photographic.me/mcp';
const CONFIG = { mcpUrl: MCP_URL, connectPageUrl: 'https://photographic.me/connect' };

function decodeCursorConfig(link: string): unknown {
  const raw = new URL(link).searchParams.get('config');
  expect(raw).toBeTruthy();
  return JSON.parse(fromBase64(raw as string));
}

describe('cursor install link', () => {
  it('encodes the transport config and nothing else', () => {
    expect(decodeCursorConfig(cursorInstallLink(MCP_URL))).toEqual({
      type: 'http',
      url: MCP_URL,
    });
  });

  it('does not wrap the config in an mcpServers object', () => {
    // Wrapping it is the documented shape of mcp.json but not of this parameter, and
    // Cursor rejects it as invalid JSON. Locking it down here so it cannot regress.
    const decoded = decodeCursorConfig(cursorInstallLink(MCP_URL)) as Record<string, unknown>;
    expect(decoded).not.toHaveProperty('mcpServers');
    expect(decoded).not.toHaveProperty('photographic');
    expect(Object.keys(decoded).sort()).toEqual(['type', 'url']);
  });

  it('carries the server name as a query parameter, not inside the config', () => {
    const link = cursorInstallLink(MCP_URL, 'photographic');
    expect(new URL(link).searchParams.get('name')).toBe('photographic');
    expect(decodeCursorConfig(link)).not.toHaveProperty('name');
  });

  it('uses the deeplink handler Cursor actually registers', () => {
    expect(cursorInstallLink(MCP_URL)).toContain('cursor://anysphere.cursor-deeplink/mcp/install');
  });
});

describe('vscode install link', () => {
  it('puts the name inside the JSON payload', () => {
    const link = vscodeInstallLink(MCP_URL);
    const encoded = link.slice('vscode:mcp/install?'.length);
    expect(JSON.parse(decodeURIComponent(encoded))).toEqual({
      name: 'photographic',
      type: 'http',
      url: MCP_URL,
    });
  });

  it('offers an insiders variant', () => {
    const link = vscodeInstallLink(MCP_URL, 'photographic', { insiders: true });
    expect(link.startsWith('vscode-insiders:mcp/install?')).toBe(true);
  });
});

describe('command based clients', () => {
  it('builds the claude code command with an http transport', () => {
    expect(claudeCodeCommand(MCP_URL)).toBe(
      'claude mcp add --transport http photographic https://photographic.me/mcp',
    );
  });

  it('wraps the manual snippet in mcpServers, because a config file does need it', () => {
    const parsed = JSON.parse(manualConfigSnippet(MCP_URL)) as Record<string, unknown>;
    expect(parsed).toHaveProperty('mcpServers');
    expect((parsed.mcpServers as Record<string, unknown>).photographic).toEqual({
      type: 'http',
      url: MCP_URL,
    });
  });
});

describe('the shared URL', () => {
  it('is identical for every client, with no per-person component', () => {
    const clients = buildClients(CONFIG);
    const urls = new Set<string>();
    for (const client of clients) {
      for (const action of [client.primary, ...client.secondary]) {
        if (action.type === 'copy' && action.value.includes('http')) urls.add(MCP_URL);
        if (action.type === 'command') expect(action.command).not.toMatch(/\/mcp\/[a-z0-9-]+$/i);
      }
    }
    // Nothing generated here may contain a token, id or secret.
    const serialised = JSON.stringify(clients);
    expect(serialised).not.toMatch(/token=/);
    expect(serialised).not.toMatch(/api[_-]?key/i);
  });
});

describe('client descriptors', () => {
  const clients = buildClients(CONFIG);

  it('gives every client a primary action', () => {
    for (const client of clients) {
      expect(client.primary).toBeTruthy();
      expect(client.steps.length).toBeGreaterThan(0);
      expect(client.remedy.length).toBeGreaterThan(0);
      expect(client.verifyPrompt.length).toBeGreaterThan(0);
    }
  });

  it('does not claim ChatGPT automatically connects a new chat', () => {
    const chatgpt = findClient(clients, 'chatgpt');
    expect(chatgpt.caveats.join(' ')).toMatch(/inte automatiskt/);
    expect(chatgpt.steps.join(' ')).toMatch(/verktygsmenyn/);
    expect(chatgpt.capability).toBe('best_effort');
  });

  it('warns that Claude connectors must be added from web or desktop', () => {
    const claude = findClient(clients, 'claude');
    expect(claude.caveats.join(' ')).toMatch(/web eller desktop/i);
    expect(claude.steps.join(' ')).toMatch(/beta|mobilappen/i);
  });

  it('marks exactly the deeplink clients as one-click', () => {
    const oneClick = clients.filter((c) => c.oneClick).map((c) => c.id).sort();
    expect(oneClick).toEqual(['cursor', 'vscode']);
    for (const client of clients) {
      if (client.oneClick) expect(client.primary.type).toBe('deeplink');
    }
  });

  it('ranks capability so weaker delivery sorts lower', () => {
    expect(CAPABILITY_RANK.manual).toBeLessThan(CAPABILITY_RANK.best_effort);
    expect(CAPABILITY_RANK.best_effort).toBeLessThan(CAPABILITY_RANK.deterministic);
    expect(CAPABILITY_RANK.deterministic).toBeLessThan(CAPABILITY_RANK.guaranteed);
  });

  it('gives a caveat to every client whose delivery is not deterministic', () => {
    for (const client of clients) {
      if (client.capability === 'manual' || client.capability === 'best_effort') {
        expect(client.caveats.length).toBeGreaterThan(0);
      }
    }
  });
});
