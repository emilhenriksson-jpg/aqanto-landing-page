/**
 * The connect screen as data.
 *
 * Every string a person reads lives in this file rather than inside a function, so the
 * web app maps over descriptors and never has to know which client needs which trick.
 * Adding a client should mean adding one entry here.
 */

import type { AgentClient, DeliveryMethod } from '@photographic/core';
import {
  claudeCodeCommand,
  codexCommand,
  cursorInstallLink,
  DEFAULT_SERVER_NAME,
  manualConfigSnippet,
  vscodeInstallLink,
} from './install-links.js';

export type ClientId = 'cursor' | 'vscode' | 'claude-code' | 'claude' | 'chatgpt' | 'codex';

/**
 * How reliably the personal profile reaches the model in this client. Ranked, because
 * we sort the connect screen by it and show it honestly on the health screen.
 *
 *  - `guaranteed`    our own surface; the profile is in the system prompt
 *  - `deterministic` a documented hook or instruction field the client always reads
 *  - `best_effort`   the model has to choose to call a tool
 *  - `manual`        no connector path; the person pastes their profile
 */
export type CapabilityLevel = 'guaranteed' | 'deterministic' | 'best_effort' | 'manual';

export type ConnectAction =
  | { type: 'deeplink'; label: string; url: string }
  | { type: 'command'; label: string; command: string }
  | { type: 'copy'; label: string; value: string };

export interface ClientDescriptor {
  id: ClientId;
  displayName: string;
  /** Which `AgentClient` values a session from this client can report as. */
  agentClients: AgentClient[];
  capability: CapabilityLevel;
  expectedDelivery: DeliveryMethod;
  /** True only when a single click finishes the configuration. */
  oneClick: boolean;
  primary: ConnectAction;
  secondary: ConnectAction[];
  steps: string[];
  /** Known limitations, stated plainly. Empty only when there genuinely are none. */
  caveats: string[];
  /** What we ask the person to say, to prove context actually arrived. */
  verifyPrompt: string;
  /** Shown when verification times out. Specific to this client, never generic. */
  remedy: string;
}

export interface ConnectConfig {
  /** The single shared endpoint, e.g. `https://photographic.me/mcp`. */
  mcpUrl: string;
  /** Where the connect screen itself lives, for the phone QR code. */
  connectPageUrl: string;
  serverName?: string;
}

const VERIFY = 'Vad vet du om mig?';

export function buildClients(config: ConnectConfig): ClientDescriptor[] {
  const name = config.serverName ?? DEFAULT_SERVER_NAME;
  const { mcpUrl } = config;

  return [
    {
      id: 'cursor',
      displayName: 'Cursor',
      agentClients: ['cursor'],
      capability: 'deterministic',
      expectedDelivery: 'mcp_instructions',
      oneClick: true,
      primary: {
        type: 'deeplink',
        label: 'Lägg till i Cursor',
        url: cursorInstallLink(mcpUrl, name),
      },
      secondary: [
        { type: 'copy', label: 'Kopiera adressen', value: mcpUrl },
        { type: 'copy', label: 'Kopiera konfigurationen', value: manualConfigSnippet(mcpUrl, name) },
      ],
      steps: [
        'Klicka på knappen. Cursor öppnas och frågar om servern ska läggas till.',
        'Godkänn, och logga in med ditt Photographic-konto när webbläsaren öppnas.',
      ],
      caveats: [],
      verifyPrompt: VERIFY,
      remedy:
        'Uppdatera Cursor till senaste versionen — installationslänkar var tillfälligt ' +
        'trasiga i äldre versioner. Annars: Customize → MCPs → Add, och klistra in adressen.',
    },
    {
      id: 'claude',
      displayName: 'Claude',
      agentClients: ['claude-desktop', 'claude-mobile'],
      capability: 'deterministic',
      expectedDelivery: 'mcp_instructions',
      oneClick: false,
      primary: { type: 'copy', label: 'Kopiera adressen', value: mcpUrl },
      secondary: [],
      steps: [
        'Öppna Claude i webbläsaren eller i skrivbordsappen — inte i mobilappen.',
        'Gå till Settings → Connectors → Add custom connector.',
        'Klistra in adressen och godkänn inloggningen.',
        'Därefter fungerar det även i mobilappen, på samma konto.',
      ],
      caveats: [
        'Kopplingen måste läggas till från web eller desktop. Att lägga till egna ' +
          'connectors direkt i mobilappen är fortfarande i beta.',
      ],
      verifyPrompt: VERIFY,
      remedy:
        'Kontrollera att du lade till kopplingen från web eller desktop, inte från ' +
        'mobilappen, och att du godkände inloggningen i webbläsaren.',
    },
    {
      id: 'claude-code',
      displayName: 'Claude Code',
      agentClients: ['claude-code'],
      capability: 'deterministic',
      expectedDelivery: 'hook',
      oneClick: false,
      primary: {
        type: 'command',
        label: 'Kör i terminalen',
        command: claudeCodeCommand(mcpUrl, name),
      },
      secondary: [{ type: 'copy', label: 'Kopiera adressen', value: mcpUrl }],
      steps: [
        'Kör kommandot i terminalen.',
        'Kör `/mcp` i Claude Code och logga in när webbläsaren öppnas.',
      ],
      caveats: [],
      verifyPrompt: VERIFY,
      remedy: 'Kör `claude mcp list` och kontrollera att photographic står som ansluten.',
    },
    {
      id: 'vscode',
      displayName: 'VS Code',
      agentClients: ['unknown'],
      capability: 'deterministic',
      expectedDelivery: 'mcp_instructions',
      oneClick: true,
      primary: {
        type: 'deeplink',
        label: 'Lägg till i VS Code',
        url: vscodeInstallLink(mcpUrl, name),
      },
      secondary: [
        {
          type: 'deeplink',
          label: 'Lägg till i VS Code Insiders',
          url: vscodeInstallLink(mcpUrl, name, { insiders: true }),
        },
        { type: 'command', label: 'Eller via terminalen', command: `code --add-mcp '${JSON.stringify({ name, type: 'http', url: mcpUrl })}'` },
      ],
      steps: [
        'Klicka på knappen och välj var servern ska gälla — Global räcker.',
        'Logga in med ditt Photographic-konto när webbläsaren öppnas.',
      ],
      caveats: [],
      verifyPrompt: VERIFY,
      remedy: 'Kör `MCP: List Servers` i kommandopaletten och kontrollera statusen.',
    },
    {
      id: 'codex',
      displayName: 'Codex',
      agentClients: ['codex'],
      capability: 'best_effort',
      expectedDelivery: 'tool_call',
      oneClick: false,
      primary: { type: 'command', label: 'Kör i terminalen', command: codexCommand(mcpUrl, name) },
      secondary: [
        { type: 'copy', label: 'Kopiera konfigurationen', value: manualConfigSnippet(mcpUrl, name) },
      ],
      steps: ['Kör kommandot i terminalen.', 'Logga in när webbläsaren öppnas.'],
      caveats: [
        'Codex läser inte serverns instruktioner automatiskt, så din profil hämtas ' +
          'först när modellen väljer att göra det.',
      ],
      verifyPrompt: VERIFY,
      remedy: 'Kontrollera `~/.codex/config.toml` och starta om Codex.',
    },
    {
      id: 'chatgpt',
      displayName: 'ChatGPT',
      agentClients: ['chatgpt-web'],
      capability: 'manual',
      expectedDelivery: 'tool_call',
      oneClick: false,
      primary: { type: 'copy', label: 'Kopiera adressen', value: mcpUrl },
      secondary: [
        {
          type: 'copy',
          label: 'Kopiera din profil istället',
          // Resolved by the web app against /v1/context/rendered; the placeholder keeps
          // this module free of I/O.
          value: '',
        },
      ],
      steps: [
        'Öppna ChatGPT i webbläsaren och slå på Developer mode under Settings → Connectors.',
        'Lägg till en connector, klistra in adressen och godkänn inloggningen.',
      ],
      caveats: [
        'Fungerar bara i webbläsaren. Connectors går inte att lägga till från ' +
          'ChatGPT-appen.',
        'ChatGPT:s röstläge kan inte anropa connectors, så din profil når inte fram ' +
          'när du pratar med den.',
        'Vill du ha kontext i röstläget: kopiera din profil och klistra in den under ' +
          'Custom Instructions. Det fungerar överallt, men uppdateras inte av sig självt.',
      ],
      verifyPrompt: VERIFY,
      remedy:
        'Developer mode måste vara påslaget, och det går bara från webbläsaren. ' +
        'Går det inte: kopiera din profil till Custom Instructions istället.',
    },
  ];
}

/** Ranked worst-to-best so sorts read naturally. */
export const CAPABILITY_RANK: Record<CapabilityLevel, number> = {
  manual: 0,
  best_effort: 1,
  deterministic: 2,
  guaranteed: 3,
};

export function findClient(clients: ClientDescriptor[], id: ClientId): ClientDescriptor {
  const found = clients.find((c) => c.id === id);
  if (!found) throw new Error(`unknown client: ${id}`);
  return found;
}
