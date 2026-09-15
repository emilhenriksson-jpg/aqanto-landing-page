/**
 * One-click install links.
 *
 * Every person connects to the same URL. Identity arrives with the OAuth flow, never
 * in the address, so nothing generated here is a secret and all of it is safe to put
 * on a public page, in a screenshot or in a support thread.
 */

export const DEFAULT_SERVER_NAME = 'photographic';

/** The `mcp.json` transport config for a remote streamable-HTTP MCP server. */
export interface TransportConfig {
  type: 'http';
  url: string;
}

export function transportConfig(mcpUrl: string): TransportConfig {
  return { type: 'http', url: mcpUrl };
}

function toBase64(input: string): string {
  const g = globalThis as { btoa?: (s: string) => string };
  if (typeof g.btoa === 'function') return g.btoa(input);
  return Buffer.from(input, 'utf8').toString('base64');
}

export function fromBase64(input: string): string {
  const g = globalThis as { atob?: (s: string) => string };
  if (typeof g.atob === 'function') return g.atob(input);
  return Buffer.from(input, 'base64').toString('utf8');
}

/**
 * Cursor install deeplink.
 *
 * `config` is the base64 of the transport config *alone*. Wrapping it in an outer
 * `{ "<name>": { ... } }` object is the documented shape of `mcp.json` but not of this
 * parameter, and Cursor rejects it as invalid JSON. That mistake is common enough that
 * `install-links.test.ts` decodes our own output and asserts the absence of a wrapper.
 */
export function cursorInstallLink(mcpUrl: string, name: string = DEFAULT_SERVER_NAME): string {
  const config = toBase64(JSON.stringify(transportConfig(mcpUrl)));
  return (
    'cursor://anysphere.cursor-deeplink/mcp/install' +
    `?name=${encodeURIComponent(name)}&config=${encodeURIComponent(config)}`
  );
}

/**
 * VS Code / Copilot install link. Here the server name travels *inside* the JSON,
 * which is a different shape from Cursor's for no reason other than history.
 */
export function vscodeInstallLink(
  mcpUrl: string,
  name: string = DEFAULT_SERVER_NAME,
  options: { insiders?: boolean } = {},
): string {
  const payload = { name, ...transportConfig(mcpUrl) };
  const scheme = options.insiders ? 'vscode-insiders' : 'vscode';
  return `${scheme}:mcp/install?${encodeURIComponent(JSON.stringify(payload))}`;
}

export function claudeCodeCommand(mcpUrl: string, name: string = DEFAULT_SERVER_NAME): string {
  return `claude mcp add --transport http ${name} ${mcpUrl}`;
}

export function codexCommand(mcpUrl: string, name: string = DEFAULT_SERVER_NAME): string {
  return `codex mcp add ${name} --url ${mcpUrl}`;
}

/** What someone pastes into a client that has no install link at all. */
export function manualConfigSnippet(mcpUrl: string, name: string = DEFAULT_SERVER_NAME): string {
  return JSON.stringify({ mcpServers: { [name]: transportConfig(mcpUrl) } }, null, 2);
}
