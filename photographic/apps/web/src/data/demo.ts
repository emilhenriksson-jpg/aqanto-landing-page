/**
 * Demo data for the room UI.
 *
 * Screens are designed against this shape. Live loads map REST responses onto the
 * same types in `load.ts`; flip `VITE_USE_DEMO=0` to leave demo behind.
 */

import { PROFILE_TOKEN_BUDGET } from '@photographic/core';

export type RoomKind = 'personal' | 'shared';

export interface RoomCard {
  id: string;
  kind: RoomKind;
  title: string;
  headline: string;
  memberCount: number;
  memberNames: string[];
  unseenCount: number;
}

export interface MemoryLine {
  shortId: string;
  kind: 'identity' | 'fact' | 'preference' | 'instruction' | 'never' | 'note' | 'decision';
  body: string;
}

export interface RoomDetail extends RoomCard {
  brief: string | null;
  memories: MemoryLine[];
  tokenCount: number;
  tokenCeiling: number;
}

export const DEMO_PERSON = {
  displayName: 'Emil',
  email: 'emil@example.com',
};

export const DEMO_ROOMS: RoomCard[] = [
  {
    id: 'personal',
    kind: 'personal',
    title: 'Ditt rum',
    headline: 'Det Claude och ChatGPT läser om dig innan de svarar',
    memberCount: 1,
    memberNames: ['Emil'],
    unseenCount: 0,
  },
  {
    id: 'ledning',
    kind: 'shared',
    title: 'Buyersclub Ledning',
    headline: 'Ledningsgruppen i Buyersclub. Beslut, underlag och styrelsematerial.',
    memberCount: 3,
    memberNames: ['Emil', 'Anna', 'Jacob'],
    unseenCount: 2,
  },
  {
    id: 'villan',
    kind: 'shared',
    title: 'Villan',
    headline: 'Renovering av villan: offerter, hantverkare och tidplan',
    memberCount: 2,
    memberNames: ['Emil', 'Vera'],
    unseenCount: 1,
  },
  {
    id: 'tomt',
    kind: 'shared',
    title: 'Tomt rum',
    headline: 'Inget sparat än',
    memberCount: 1,
    memberNames: ['Emil'],
    unseenCount: 0,
  },
];

const PERSONAL_MEMORIES: MemoryLine[] = [
  { shortId: 'p-h58j', kind: 'identity', body: 'Emil, 34, bor i Stockholm' },
  { shortId: 'p-da7k', kind: 'fact', body: 'Allergisk mot ketchup' },
  { shortId: 'p-qm5s', kind: 'fact', body: 'Dottern heter Vera, 4 år' },
  {
    shortId: 'p-qrfa',
    kind: 'preference',
    body: 'Vill ha korta svar utan inledande artighetsfraser',
  },
  {
    shortId: 'p-zsyt',
    kind: 'instruction',
    body: 'Utmana alltid mina idéer innan du hjälper mig genomföra dem',
  },
  { shortId: 'p-nv01', kind: 'never', body: 'Anta aldrig att jag kör bil' },
];

const ROOM_MEMORIES: Record<string, { brief: string; memories: MemoryLine[] }> = {
  ledning: {
    brief:
      'Ledningsgruppen arbetar mot en Q3-förvärvsplan. Senaste beslutet: skjuta due diligence till efter sommaren. Styrelsematerial ligger i rummet.',
    memories: [
      {
        shortId: 'r-8k2m',
        kind: 'decision',
        body: 'Vi beslutade att skjuta förvärvet till Q3',
      },
      {
        shortId: 'r-3n9p',
        kind: 'note',
        body: 'Due diligence-paketet skickas till styrelsen 12 juni',
      },
    ],
  },
  villan: {
    brief:
      'Köksrenovering planerad till mars. Peab har offererat 340 000 kr. Elektrikern heter Micke.',
    memories: [
      {
        shortId: 'r-4v7q',
        kind: 'note',
        body: 'Renoveringen av köket börjar i mars, Peab har offererat 340 000 kr',
      },
      {
        shortId: 'r-2m1c',
        kind: 'fact',
        body: 'Elektrikern heter Micke och nås på 070-1234567',
      },
    ],
  },
  tomt: {
    brief: '',
    memories: [],
  },
};

export function loadRoom(id: string): RoomDetail | null {
  const card = DEMO_ROOMS.find((room) => room.id === id);
  if (!card) return null;

  if (card.kind === 'personal') {
    return {
      ...card,
      brief: null,
      memories: PERSONAL_MEMORIES,
      tokenCount: 420,
      tokenCeiling: PROFILE_TOKEN_BUDGET,
    };
  }

  const extra = ROOM_MEMORIES[id] ?? { brief: '', memories: [] };
  return {
    ...card,
    brief: extra.brief || null,
    memories: extra.memories,
    tokenCount: 0,
    tokenCeiling: 0,
  };
}

export const SECTION_LABELS: Record<MemoryLine['kind'], string> = {
  identity: 'Identitet',
  fact: 'Fakta',
  preference: 'Preferenser',
  instruction: 'Instruktioner',
  never: 'Aldrig',
  note: 'Anteckningar',
  decision: 'Beslut',
};

/** Personal-room section order from DESIGN.md. */
export const PERSONAL_SECTION_ORDER: MemoryLine['kind'][] = [
  'identity',
  'fact',
  'preference',
  'instruction',
  'never',
  'decision',
  'note',
];

/**
 * Connected AI clients and whether the personal profile actually reached them.
 * Green = delivered as expected, amber = best-effort channel, red = never landed.
 */
export type ClientHealthTone = 'ok' | 'warn' | 'bad';

export interface DemoClient {
  id: string;
  displayName: string;
  lastSeenAt: string | null;
  profileDelivered: boolean;
  /** How the profile arrived, when it did. */
  deliveryMethod: 'mcp_instructions' | 'tool_call' | null;
  degraded: boolean;
}

export const DEMO_CLIENTS: DemoClient[] = [
  {
    id: 'claude-desktop',
    displayName: 'Claude',
    lastSeenAt: '2026-09-15T22:04:00.000Z',
    profileDelivered: true,
    deliveryMethod: 'mcp_instructions',
    degraded: false,
  },
  {
    id: 'chatgpt-web',
    displayName: 'ChatGPT',
    lastSeenAt: '2026-09-15T21:48:00.000Z',
    profileDelivered: true,
    deliveryMethod: 'tool_call',
    degraded: true,
  },
  {
    id: 'codex',
    displayName: 'Codex',
    lastSeenAt: null,
    profileDelivered: false,
    deliveryMethod: null,
    degraded: false,
  },
];

export function clientHealthTone(client: DemoClient): ClientHealthTone {
  if (!client.profileDelivered) return 'bad';
  if (client.degraded) return 'warn';
  return 'ok';
}

/**
 * Pending proposals waiting for a tap. Designed as a calm feed to clear, not an inbox.
 * Live path: `loadApprovalsFromApi` maps GET /v1/memory/proposals onto this shape.
 */
export interface ApprovalItem {
  id: string;
  /** Display name of the client that proposed it, e.g. "Claude". */
  clientLabel: string;
  kind: MemoryLine['kind'];
  body: string;
  /** Human-readable explanation of why this could not be written automatically. */
  reason: string;
}

export const DEMO_APPROVALS: ApprovalItem[] = [
  {
    id: 'a-1k9q',
    clientLabel: 'Claude',
    kind: 'instruction',
    body: 'utmana alltid mina idéer',
    reason: 'Instruktioner ändrar hur varje modell beter sig — de kräver alltid ditt godkännande.',
  },
  {
    id: 'a-3m2p',
    clientLabel: 'ChatGPT',
    kind: 'fact',
    body: 'Bor i Göteborg',
    reason: 'Strider mot det som redan finns: Emil, 34, bor i Stockholm.',
  },
  {
    id: 'a-7w4c',
    clientLabel: 'Cursor',
    kind: 'preference',
    body: 'Svara alltid på engelska i kodreview',
    reason: 'Preferenser som styr hur modeller svarar granskas innan de sparas.',
  },
];

/**
 * What a recipient sees before they have an account: the room itself, readable,
 * with one violet action to join. Growth loop — polish this hard.
 */
export interface InvitePreviewData {
  token: string;
  roomTitle: string;
  brief: string | null;
  invitedByName: string;
  /** A few lines from the room — enough to know what you are joining. */
  lines: MemoryLine[];
}

/** Any `/i/:token` in demo mode resolves to this invite (Buyersclub Ledning). */
export const DEMO_INVITE: InvitePreviewData = {
  token: 'demo-ledning',
  roomTitle: 'Buyersclub Ledning',
  brief:
    'Ledningsgruppen arbetar mot en Q3-förvärvsplan. Senaste beslutet: skjuta due diligence till efter sommaren. Styrelsematerial ligger i rummet.',
  invitedByName: 'Emil',
  lines: [
    {
      shortId: 'r-8k2m',
      kind: 'decision',
      body: 'Vi beslutade att skjuta förvärvet till Q3',
    },
    {
      shortId: 'r-3n9p',
      kind: 'note',
      body: 'Due diligence-paketet skickas till styrelsen 12 juni',
    },
    {
      shortId: 'r-6t4w',
      kind: 'fact',
      body: 'Anna äger due diligence, Jacob tar styrelsepaketet',
    },
  ],
};

export function loadInvitePreview(token: string): InvitePreviewData | null {
  if (!token.trim()) return null;
  return { ...DEMO_INVITE, token };
}

/**
 * Sparse room activity — calm Swedish lines, not an audit log.
 * Demo only until a live activity endpoint exists.
 */
export interface ActivityLine {
  id: string;
  body: string;
  /** Relative Swedish meta, e.g. "Igår", "2 timmar sedan". */
  when: string;
}

export const DEMO_ACTIVITY: Record<string, ActivityLine[]> = {
  ledning: [
    {
      id: 'act-ledning-1',
      body: 'Emil sparade Vi beslutade att skjuta förvärvet till Q3',
      when: '2 timmar sedan',
    },
    {
      id: 'act-ledning-2',
      body: 'Anna gick med',
      when: 'Igår',
    },
    {
      id: 'act-ledning-3',
      body: 'Emil sparade Due diligence-paketet skickas till styrelsen 12 juni',
      when: '3 dagar sedan',
    },
  ],
};

/**
 * Sparse room documents — calm titles, not a file manager.
 * Demo only until a live documents list exists.
 */
export interface DocumentLine {
  id: string;
  title: string;
  /** Quiet meta, e.g. "PDF · igår". */
  meta: string;
}

export const DEMO_DOCUMENTS: Record<string, DocumentLine[]> = {
  personal: [
    {
      id: 'doc-personal-1',
      title: 'Vaccinationskort Vera',
      meta: 'PDF · igår',
    },
  ],
  ledning: [
    {
      id: 'doc-ledning-1',
      title: 'Due diligence-paket Q3',
      meta: 'PDF · igår',
    },
    {
      id: 'doc-ledning-2',
      title: 'Styrelseunderlag juni',
      meta: 'PDF · igår',
    },
  ],
  villan: [
    {
      id: 'doc-villan-1',
      title: 'Offert Peab kök',
      meta: 'PDF · igår',
    },
  ],
};
