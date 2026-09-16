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
  url: string;
  prompt: string;
  note: string;
  /** Installed desktop app required. Web clients open in a separate tab. */
  desktop: boolean;
  copyPromptOnOpen?: boolean;
  fallbackUrl?: string;
}

/** No profile, room identifiers, credentials or personal data belong in a URL. */
export const CHAT_START_PROMPT = `Använd Photographic som mitt minne. Börja den här nya chatten med att anropa get_context utan rum, även om du fick kontext när anslutningen öppnades. Läs min personliga profil och kompass, översikten över mina rum och senaste kalenderhändelserna. Jag ska inte behöva välja rum. När samtalet handlar om ett rum, hämta dess kontext med get_context och relevanta detaljer med search_memory eller list_history. Spara varaktiga uppgifter med remember enligt min kompass; gemensamma ändringar ska följa rummets godkännanderegler. Om kopplingen saknas eller hämtningen misslyckas, säg det tydligt och hitta inte på något om mitt minne.`;

export function chatLaunch(id: ClientId): ChatLaunch | undefined {
  const prompt = CHAT_START_PROMPT;
  const encoded = encodeURIComponent(prompt);
  switch (id) {
    case 'codex': return {
      url: `codex://threads/new?prompt=${encoded}`, prompt, desktop: true,
      note: 'Öppnar en ny chatt i datorappen med starttexten. Skicka den för att hämta ditt minne.',
    };
    case 'cursor': return {
      url: `cursor://anysphere.cursor-deeplink/prompt?text=${encoded}`, prompt, desktop: true,
      fallbackUrl: `https://cursor.com/link/prompt?text=${encoded}`,
      note: 'Öppnar starttexten i Cursor. Skicka den för att hämta ditt minne. Cursor kan använda den chatt som redan är öppen.',
    };
    case 'claude': return {
      url: `claude://claude.ai/new?q=${encoded}`, prompt, desktop: true,
      fallbackUrl: 'https://claude.ai/new',
      note: 'Öppnar en ny chatt i datorappen med starttexten. På webben: kopiera starttexten och klistra in den i chatten.',
    };
    case 'chatgpt': return {
      url: 'https://chatgpt.com/', prompt, desktop: false, copyPromptOnOpen: true,
      note: 'Starttexten kopieras när du öppnar ChatGPT. Klistra in den och välj Photographic i chattens verktygsmeny. ChatGPT tillåter inte att vi gör den kopplingen åt dig.',
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

export function buildClients(config: ConnectConfig): ClientDescriptor[] {
  const name = config.serverName ?? DEFAULT_SERVER_NAME;
  const { mcpUrl } = config;

  return [
    {
      id: 'cursor',
      displayName: 'Cursor',
      launch: chatLaunch('cursor')!,
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
      launch: chatLaunch('claude')!,
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
      launch: chatLaunch('codex')!,
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
      launch: chatLaunch('chatgpt')!,
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
