/**
 * The connect screen as data.
 *
 * Every string a person reads lives in this file rather than inside a function, so the
 * web app maps over descriptors and never has to know which client needs which trick.
 * Adding a client should mean adding one entry here.
 */

import type { Platform } from './detect.js';
import { chatgptPluginPrompt } from './chatgpt-plugin.js';
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
  /** Shortest supported setup entry point. Contains only the public server URL. */
  quickSetup?: {
    url: string;
    copyValue?: string;
    hint: string;
    steps?: string[];
  };
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
  /** An action required in each new chat, shown beside the launch button. */
  activationNote?: string;
  /** This launch requires a desktop app, rather than a mobile app. */
  desktop: boolean;
  fallbackUrl?: string;
}

/** Optional greeting only. Behavioral instructions arrive through the MCP connection. */
export const CHAT_START_PROMPT = 'Hej! Jag kommer från Photographic.';

export function chatLaunch(id: ClientId, platform: Platform = 'unknown', binding?: { chatgptPluginId?: string | null }): ChatLaunch | undefined {
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
      activationNote: 'Välj Photographic i den nya chattens verktygsmeny innan du börjar prata.',
      fallbackUrl: 'https://chatgpt.com/?no_universal_links=1',
      note: 'Öppnar ChatGPT-appen med en kort hälsning som du skickar. Välj Photographic i chattens verktygsmeny om kopplingen inte redan är vald.',
    };
    if (id === 'claude') return {
      // /new is an associated mobile route; unlike /code/new this is a regular chat.
      url: platform === 'android'
        ? 'intent://claude.ai/new#Intent;scheme=https;package=com.anthropic.claude;end'
        : 'https://claude.ai/new',
      prompt, desktop: false,
      fallbackUrl: 'https://claude.ai/new',
      note: 'Öppnar en tom chatt i Claude-appen. Börja prata när Photographic är anslutet; instruktionerna följer med genom kopplingen.',
    };
  }
  switch (id) {
    case 'codex': return {
      url: 'codex://threads/new?mode=codex', prompt, desktop: true,
      note: 'Öppnar en tom chatt i Codex. Börja prata när Photographic är anslutet; instruktionerna följer med genom kopplingen.',
    };
    case 'cursor': return {
      url: `cursor://anysphere.cursor-deeplink/prompt?text=${encoded}`, prompt, desktop: true,
      fallbackUrl: `https://cursor.com/link/prompt?text=${encoded}`,
      note: 'Öppnar Cursor med en kort hälsning som du skickar. Cursor kan använda den chatt som redan är öppen.',
    };
    case 'claude': return {
      url: 'claude://claude.ai/new', prompt, desktop: true,
      fallbackUrl: 'https://claude.ai/new',
      note: 'Öppnar en tom chatt i Claude. Börja prata när Photographic är anslutet; instruktionerna följer med genom kopplingen.',
    };
    case 'chatgpt': {
      const mention = chatgptPluginPrompt(binding?.chatgptPluginId);
      return {
      // ChatGPT retains codex://, but the mode must be explicit: otherwise the app
      // can keep its active Codex mode and start a local task in the current project.
      url: `codex://threads/new?mode=chat${mention ? `&prompt=${encodeURIComponent(mention)}` : ''}`,
      prompt: mention ?? prompt, desktop: true,
      activationNote: mention
        ? 'Photographic och en kort startfråga följer med. Skicka den för att läsa ditt minne och få förslag på det som saknas.'
        : 'Välj Photographic i den nya chattens verktygsmeny innan du börjar prata.',
      fallbackUrl: 'https://chatgpt.com/?no_universal_links=1',
      note: mention
        ? 'Öppnar en ny ChatGPT-chatt med din Photographic-koppling markerad i skrivfältet. Länken skickar inget meddelande automatiskt. ChatGPT kan be dig bekräfta verktygsanrop.'
        : 'Öppnar en tom ChatGPT-chatt i datorappen. Välj Photographic i chattens verktygsmeny om kopplingen inte redan är vald, och börja prata.',
    }; }
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

const VERIFY = 'Hämta mitt minne från Photographic nu. Om du inte har tillgång till Photographics verktyg, säg det.';

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
      quickSetup: {
        url: cursorInstallLink(mcpUrl, name),
        hint: 'Öppnar Cursor med Photographic förberett. Godkänn och logga in.',
        steps: ['Godkänn att Photographic läggs till i Cursor.', 'Logga in med ditt Photographic-konto när webbläsaren öppnas.'],
      },
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
      quickSetup: {
        url: 'https://claude.ai/customize/connectors',
        copyValue: mcpUrl,
        hint: 'Kopierar adressen och öppnar Claudes kopplingar i webbläsaren.',
        steps: ['Tryck på plus och välj Add custom connector.', 'Ange namnet Photographic, klistra in adressen och godkänn inloggningen.'],
      },
      primary: { type: 'copy', label: 'Kopiera adressen', value: mcpUrl },
      secondary: [],
      steps: [
        'Öppna Claude i webbläsaren eller i skrivbordsappen — inte i mobilappen.',
        'Gå till Customize → Connectors, tryck på plus och välj Add custom connector.',
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
      quickSetup: {
        url: 'codex://settings',
        copyValue: mcpUrl,
        hint: 'Kopierar adressen och öppnar inställningarna i datorappen.',
        steps: [
          'Välj MCP servers → Add server i inställningarna.',
          'Ange namnet Photographic, välj Streamable HTTP och klistra in adressen.',
          'Spara, välj Restart och sedan Authenticate för att godkänna inloggningen.',
        ],
      },
      primary: { type: 'command', label: 'Kör i terminalen', command: codexCommand(mcpUrl, name) },
      secondary: [
        { type: 'copy', label: 'Kopiera konfigurationen', value: manualConfigSnippet(mcpUrl, name) },
      ],
      steps: ['Kör kommandot i terminalen.', 'Kör `codex mcp login photographic` och godkänn inloggningen.', 'Öppna en ny chatt från Photographic.'],
      caveats: [
        'En ny chatt är tom. Photographic måste vara anslutet och tillgängligt som verktyg för att din AI ska kunna hämta ditt minne.',
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
      quickSetup: {
        url: 'https://chatgpt.com/plugins',
        copyValue: mcpUrl,
        hint: 'Kopierar adressen för en egen koppling. Photographic finns inte i plugin-katalogen ännu.',
        steps: [
          'Slå på Developer mode under Settings → Security and login, om ditt konto tillåter det.',
          'Välj Add → Create MCP App på pluginsidan. Du ska skapa en egen koppling, inte söka i katalogen.',
          'Ange namnet Photographic, klistra in adressen som Server URL och behåll OAuth. Välj Create och godkänn inloggningen.',
        ],
      },
      primary: { type: 'copy', label: 'Kopiera adressen', value: mcpUrl },
      secondary: [
        { type: 'deeplink', label: 'Öppna ChatGPTs pluginsida', url: 'https://chatgpt.com/plugins' },
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
        'Öppna Plugins → Add → Create MCP App. Ange Photographic och adressen ovan, behåll OAuth och godkänn inloggningen. Photographic går ännu inte att söka fram i katalogen.',
        'Starta en ny chatt och välj Photographic i verktygsmenyn.',
      ],
      caveats: [
        'Tillgången till egna kopplingar beror på konto och arbetsplatsens regler.',
        'Att öppna ChatGPT ansluter inte automatiskt Photographic till chatten.',
      ],
      verifyPrompt: VERIFY,
      remedy:
        'Developer mode måste vara påslaget, och det går bara från webbläsaren. ' +
        'Kontrollera sedan att Photographic är valt i den nya chattens verktygsmeny. En inklistrad profil ger ingen levande koppling till Photographic.',
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
