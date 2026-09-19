/**
 * The connect screen as data.
 *
 * Every string a person reads lives in this file rather than inside a function, so the
 * web app maps over descriptors and never has to know which client needs which trick.
 * Adding a client should mean adding one entry here.
 */

import type { Platform } from './detect.js';
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
  /** Chat launch is distinct from first-time authorization. */
  launch?: ChatLaunch;
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

export interface ChatLaunch {
  /** Null when no supported native chat launch exists on this device. */
  url: string | null;
  prompt: string;
  note: string;
  /** This launch requires a desktop app, rather than a mobile app. */
  desktop: boolean;
  fallbackUrl?: string;
}

/** No profile, room identifiers, credentials or personal data belong in a URL. */
export const CHAT_START_PROMPT = 'Hej! Jag kommer från Photographic.';

export function chatLaunch(id: ClientId, platform: Platform = 'unknown'): ChatLaunch | undefined {
  const prompt = CHAT_START_PROMPT;
  const encoded = encodeURIComponent(prompt);
  const mobile = platform === 'ios' || platform === 'android';
  if (mobile) {
    if (id === 'codex' || id === 'cursor') return {
      url: null, prompt, desktop: false,
      note: `${id === 'codex' ? 'Codex' : 'Cursor'} har ingen stödd länk för att starta den här chatten i en mobilapp. Öppna Photographic på datorn, eller välj ChatGPT eller Claude här.`,
    };
    if (id === 'chatgpt') return {
      // iOS Universal Link: the official association explicitly accepts ?q=.
      // Android Intent targets the vendor's verified package; no web redirect timer.
      url: platform === 'android'
        ? `intent://chatgpt.com/?q=${encoded}#Intent;scheme=https;package=com.openai.chatgpt;end`
        : `https://chatgpt.com/?q=${encoded}`,
      prompt, desktop: false,
      fallbackUrl: 'https://chatgpt.com/?no_universal_links=1',
      note: 'Öppnar ChatGPT-appen med en kort hälsning att skicka. Välj Photographic i chattens verktygsmeny om kopplingen inte redan är vald.',
    };
    if (id === 'claude') return {
      // /new is an associated mobile route; unlike /code/new this is a regular chat.
      url: platform === 'android'
        ? 'intent://claude.ai/new#Intent;scheme=https;package=com.anthropic.claude;end'
        : 'https://claude.ai/new',
      prompt, desktop: false,
      fallbackUrl: 'https://claude.ai/new',
      note: 'Öppnar en ny chatt i Claude-appen. Börja med att säga hej när Photographic är anslutet.',
    };
  }
  switch (id) {
    case 'codex': return {
      url: `codex://threads/new?mode=codex`, prompt, desktop: true,
      note: 'Öppnar en ny chatt i datorappen. Börja med att säga hej när Photographic är anslutet.',
    };
    case 'cursor': return {
      url: `cursor://anysphere.cursor-deeplink/prompt?text=${encoded}`, prompt, desktop: true,
      fallbackUrl: `https://cursor.com/link/prompt?text=${encoded}`,
      note: 'Öppnar en kort hälsning i Cursor. Cursor kan använda den chatt som redan är öppen.',
    };
    case 'claude': return {
      url: `claude://claude.ai/new`, prompt, desktop: true,
      fallbackUrl: 'https://claude.ai/new',
      note: 'Öppnar en ny chatt i Claude-appen. Börja med att säga hej när Photographic är anslutet.',
    };
    case 'chatgpt': return {
      // ChatGPT retains codex://, but the mode must be explicit: otherwise the app
      // can keep its active Codex mode and start a local task in the current project.
      url: `codex://threads/new?mode=chat`, prompt, desktop: true,
      fallbackUrl: 'https://chatgpt.com/?no_universal_links=1',
      note: 'Öppnar en ny chatt i den aktuella ChatGPT-appen. Välj Photographic i chattens verktygsmeny om kopplingen inte redan är vald och säg hej.',
    };
    default: return undefined;
  }
}

export interface ConnectConfig {
  /** The single shared endpoint, e.g. `https://photographic.me/mcp`. */
  mcpUrl: string;
  /** Where the connect screen itself lives, for the phone QR code. */
  connectPageUrl: string;
  serverName?: string;
}

const VERIFY = 'Vad vet du om mig?';

export function buildClients(config: ConnectConfig, platform: Platform = 'unknown'): ClientDescriptor[] {
  const name = config.serverName ?? DEFAULT_SERVER_NAME;
  const { mcpUrl } = config;

  return [
    {
      id: 'cursor',
      displayName: 'Cursor',
      launch: chatLaunch('cursor', platform)!,
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
      launch: chatLaunch('claude', platform)!,
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
      launch: chatLaunch('codex', platform)!,
      agentClients: ['codex'],
      capability: 'best_effort',
      expectedDelivery: 'tool_call',
      oneClick: false,
      primary: { type: 'command', label: 'Kör i terminalen', command: codexCommand(mcpUrl, name) },
      secondary: [
        { type: 'copy', label: 'Kopiera konfigurationen', value: manualConfigSnippet(mcpUrl, name) },
      ],
      steps: ['Kör kommandot i terminalen.', 'Kör `codex mcp login photographic` och godkänn inloggningen.', 'Öppna en ny chatt från Photographic.'],
      caveats: [
        'Starttexten ber Codex hämta färsk kontext. Vi kan bekräfta leveransen först när Photographic har fått en förfrågan.',
      ],
      verifyPrompt: VERIFY,
      remedy: 'Kontrollera `~/.codex/config.toml` och starta om Codex.',
    },
    {
      id: 'chatgpt',
      displayName: 'ChatGPT',
      launch: chatLaunch('chatgpt', platform)!,
      agentClients: ['chatgpt-web'],
      capability: 'best_effort',
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
        'Öppna ChatGPT → Settings → Security and login och slå på Developer mode, om ditt konto tillåter det.',
        'Öppna Plugins, tryck på plus och lägg till Photographic med adressen ovan. Godkänn inloggningen.',
        'Starta en ny chatt och välj Photographic i verktygsmenyn.',
      ],
      caveats: [
        'Tillgången till egna kopplingar beror på konto och arbetsplatsens regler.',
        'Att öppna ChatGPT ansluter inte automatiskt Photographic till chatten.',
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
