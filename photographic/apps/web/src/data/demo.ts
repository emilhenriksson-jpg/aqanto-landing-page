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
 * Live path: `loadDocumentsFromApi` maps GET /v1/rooms/:id/documents
 * (title = filename, meta = "Dokument").
 */
export interface DocumentLine {
  id: string;
  title: string;
  /** Quiet meta, e.g. "3 sidor · 1,2 MB" or why the file is not searchable. */
  meta: string;
  /** False when extraction found no text, so the shelf can say so. */
  searchable?: boolean;
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

/**
 * Soft-deleted lines waiting in the trash. Sparse on purpose — this screen should
 * feel like a quiet shelf, not a dump. Live path: GET /v1/trash.
 */
export interface TrashLine {
  shortId: string;
  roomTitle: string;
  body: string;
  /** Swedish meta, e.g. "28 dagar kvar". */
  daysLabel: string;
  deleteReason: string | null;
}

export const DEMO_TRASH: TrashLine[] = [
  {
    shortId: 'p-old1',
    roomTitle: 'Ditt rum',
    body: 'Bor i Malmö',
    daysLabel: '28 dagar kvar',
    deleteReason: 'Flyttade till Stockholm',
  },
  {
    shortId: 'r-old2',
    roomTitle: 'Buyersclub Ledning',
    body: 'Vi siktar på förvärv i Q2',
    daysLabel: '12 dagar kvar',
    deleteReason: 'Skjutits till Q3',
  },
];

/**
 * The calendar: what Photographic did with what you told it, one day at a time.
 *
 * The screen is designed against this shape and `load.ts` maps the live day onto the
 * same types. Eight kinds, each with its own glyph and its own Swedish label, because a
 * day where two things were saved privately and one was shared with three people is not
 * a list of three identical rows.
 */
export type MemoryEventKind =
  | 'saved_private'
  | 'saved_to_room'
  | 'shared'
  | 'updated'
  | 'moved'
  | 'deleted'
  | 'restored'
  | 'disputed';

export interface DayEvent {
  seq: number;
  kind: MemoryEventKind;
  /** `14:02`, in the person's own timezone. */
  time: string;
  shortId: string | null;
  /** What. Null once the text has been purged. */
  body: string | null;
  /** What it said before, for an edit. Shown beside the new value, never instead of it. */
  previousBody: string | null;
  roomTitle: string;
  /** Which room it came from, for a move or a share. */
  fromRoomTitle: string | null;
  /** Who did it: "Claude", "Du", "Anna". */
  who: string;
  /** Why it was stored where it was stored. */
  motivation: string | null;
  /** Where the information came from, before it was a memory. */
  sourceLabel: string | null;
  /** Who could read it as of the moment it was shared. */
  sharedWith: string[];
  /** The two statements that cannot both be true. */
  disputes: Array<{ shortId: string | null; body: string | null; authorName: string | null }>;
  /** Somebody else did this, in a room you share with them. */
  byOtherMember: boolean;
  /** The memory has been corrected since. */
  changed: boolean;
  redacted: boolean;
}

export interface DayView {
  date: string;
  /** "tisdag 15 september 2026", as a person reads a date. */
  heading: string;
  roomTitle: string | null;
  events: DayEvent[];
  byOthersCount: number;
  previousDate: string | null;
  nextDate: string | null;
}

/** Glyphs from the scope's own table, plus the eighth row for a disagreement. */
export const EVENT_GLYPH: Record<MemoryEventKind, string> = {
  saved_private: '🔒',
  saved_to_room: '📁',
  shared: '👥',
  updated: '✏️',
  moved: '↔️',
  deleted: '🗑',
  restored: '♻️',
  disputed: '⚠️',
};

export const EVENT_LABEL: Record<MemoryEventKind, string> = {
  saved_private: 'Sparat privat',
  saved_to_room: 'Sparat i rum',
  shared: 'Delat',
  updated: 'Uppdaterat',
  moved: 'Flyttat',
  deleted: 'Borttaget',
  restored: 'Återställt',
  disputed: 'Omtvistat',
};

export const DEMO_DAY: DayView = {
  date: '2026-09-15',
  heading: 'tisdag 15 september 2026',
  roomTitle: null,
  byOthersCount: 1,
  previousDate: '2026-09-14',
  nextDate: null,
  events: [
    {
      seq: 412,
      kind: 'saved_private',
      time: '08:14',
      shortId: 'p-qm5s',
      body: 'Dottern heter Vera, 4 år',
      previousBody: null,
      roomTitle: 'Ditt rum',
      fromRoomTitle: null,
      who: 'Claude',
      motivation: 'Handlar om dig, och sparas därför bara privat.',
      sourceLabel: 'Samtal med Claude',
      sharedWith: [],
      disputes: [],
      byOtherMember: false,
      changed: false,
      redacted: false,
    },
    {
      seq: 418,
      kind: 'updated',
      time: '11:02',
      shortId: 'r-8k2m',
      body: 'Lanseringen är 1 november',
      previousBody: 'Lanseringen är 15 oktober',
      roomTitle: 'Buyersclub Ledning',
      fromRoomTitle: null,
      who: 'Du',
      motivation: 'Uppgiften stämde inte längre. Den gamla finns kvar i historiken.',
      sourceLabel: 'Du, i Photographic',
      sharedWith: [],
      disputes: [],
      byOtherMember: false,
      changed: false,
      redacted: false,
    },
    {
      seq: 421,
      kind: 'saved_to_room',
      time: '13:47',
      shortId: 'r-3n9p',
      body: 'Due diligence-paketet skickas till styrelsen 12 juni',
      previousBody: null,
      roomTitle: 'Buyersclub Ledning',
      fromRoomTitle: null,
      who: 'Anna',
      motivation: 'Hör till Buyersclub Ledning snarare än till ditt privata minne.',
      sourceLabel: 'Samtal med ChatGPT',
      sharedWith: [],
      disputes: [],
      byOtherMember: true,
      changed: false,
      redacted: false,
    },
    {
      seq: 425,
      kind: 'shared',
      time: '15:05',
      shortId: 'r-6t4w',
      body: 'Elektrikern heter Micke och nås på 070-1234567',
      previousBody: null,
      roomTitle: 'Villan',
      fromRoomTitle: 'Ditt rum',
      who: 'Du',
      motivation: 'Delades i Villan efter att du bekräftat det.',
      sourceLabel: 'Du, i Photographic',
      sharedWith: ['Emil', 'Vera'],
      disputes: [],
      byOtherMember: false,
      changed: false,
      redacted: false,
    },
    {
      seq: 430,
      kind: 'disputed',
      time: '16:20',
      shortId: 'r-9d1k',
      body: 'Vi siktar på förvärv i Q2',
      previousBody: null,
      roomTitle: 'Buyersclub Ledning',
      fromRoomTitle: null,
      who: 'Jacob',
      motivation:
        'Två uppgifter i Buyersclub Ledning säger olika saker. Ingen av dem har ändrats — du avgör vilken som gäller.',
      sourceLabel: 'Samtal med Claude',
      sharedWith: [],
      disputes: [
        { shortId: 'r-8k2m', body: 'Vi beslutade att skjuta förvärvet till Q3', authorName: 'Emil' },
        { shortId: 'r-9d1k', body: 'Vi siktar på förvärv i Q2', authorName: 'Jacob' },
      ],
      byOtherMember: true,
      changed: false,
      redacted: false,
    },
    {
      seq: 436,
      kind: 'deleted',
      time: '18:02',
      shortId: 'p-old1',
      body: 'Bor i Malmö',
      previousBody: null,
      roomTitle: 'Ditt rum',
      fromRoomTitle: null,
      who: 'Du',
      motivation: 'Flyttade till Stockholm',
      sourceLabel: 'Du, i Photographic',
      sharedWith: [],
      disputes: [],
      byOtherMember: false,
      changed: false,
      redacted: false,
    },
  ],
};

/**
 * One event zoomed to its source, for reviewing the screen without a backend.
 *
 * Deliberately the edit: it is the case the log exists for, so the demo should show both
 * the correction and what it corrected rather than a save with nothing behind it.
 */
export const DEMO_EVENT_DETAIL = {
  entry: {
    seq: 418,
    kind: 'updated' as const,
    occurredAt: '2026-09-15T09:02:00.000Z',
    body: 'Lanseringen är 1 november',
    previousBody: 'Lanseringen är 15 oktober',
    shortId: 'r-8k2m',
    itemKind: 'decision',
    fromRoomTitle: null,
    toRoomTitle: null,
    sharedWith: null,
    disputes: null,
    byOtherMember: false,
    redacted: false,
    provenance: {
      learnedAt: '2026-09-15T09:02:00.000Z',
      agentClient: 'claude-desktop',
      actorName: 'Emil',
      source: {
        kind: 'conversation' as const,
        label: 'Samtal med Claude',
        ref: 'session-8812',
        uri: null,
      },
      roomId: 'ledning',
      roomTitle: 'Buyersclub Ledning',
      roomKind: 'shared' as const,
      motivation: 'Uppgiften stämde inte längre. Den gamla finns kvar i historiken.',
      explicit: true,
      wasApproved: true,
      changed: false,
    },
  },
  timeline: [],
  revisions: [
    {
      seq: 401,
      at: '2026-08-28T13:20:00.000Z',
      body: 'Lanseringen är 15 oktober',
      previousBody: null,
      agentClient: 'claude-desktop',
      motivation: 'Hör till Buyersclub Ledning snarare än till ditt privata minne.',
    },
    {
      seq: 418,
      at: '2026-09-15T09:02:00.000Z',
      body: 'Lanseringen är 1 november',
      previousBody: 'Lanseringen är 15 oktober',
      agentClient: 'claude-desktop',
      motivation: 'Uppgiften stämde inte längre. Den gamla finns kvar i historiken.',
    },
  ],
  source: {
    kind: 'conversation' as const,
    label: 'Samtal med Claude',
    ref: 'session-8812',
    uri: null,
    at: '2026-09-15T08:55:00.000Z',
    agentClient: 'claude-desktop',
    transport: 'mcp',
    alsoFromHere: [
      { seq: 419, shortId: 'r-3n9p', body: 'Styrelsen informeras samma vecka' },
    ],
  },
  currentBody: 'Lanseringen är 1 november',
  trash: null,
};

/**
 * Sparse personal history — honesty about what changed, not an audit log.
 * Live path: `loadHistoryFromApi` maps GET /v1/history onto this shape.
 */
export interface HistoryLine {
  id: string;
  /** Relative Swedish meta, e.g. "Igår", "2 timmar sedan". */
  when: string;
  /** Calm Swedish line: who did what. */
  body: string;
}

export const DEMO_HISTORY: HistoryLine[] = [
  {
    id: 'hist-1',
    when: 'Igår',
    body: 'Claude sparade Dottern heter Vera, 4 år',
  },
  {
    id: 'hist-2',
    when: '3 dagar sedan',
    body: 'Du tog bort Bor i Malmö',
  },
  {
    id: 'hist-3',
    when: 'Förra veckan',
    body: 'ChatGPT föreslog Bor i Göteborg',
  },
];

/**
 * "Fråga mitt minne" — one shape for a memory, a document or a calendar entry, so the
 * screen can render all three the same way. Mirrors `AskHitDto` from the live API.
 */
export interface AskResultLine {
  id: string;
  kind: 'memory' | 'document' | 'event';
  roomId: string;
  roomTitle: string;
  text: string;
  /** Short id chip for a memory, a relative date for an event. */
  meta: string;
}

const DEMO_ROOM_TITLE: Record<string, string> = Object.fromEntries(
  DEMO_ROOMS.map((room) => [room.id, room.kind === 'personal' ? 'Ditt rum' : room.title]),
);

/**
 * A small, honest stand-in for `askMemory` (`packages/core/src/ask.ts`): plain
 * substring matching across the same demo memories every other screen already shows,
 * so a demo search never "finds" something the room screens do not also have.
 */
export function searchDemoMemory(query: string): AskResultLine[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const results: AskResultLine[] = [];

  for (const memory of PERSONAL_MEMORIES) {
    if (memory.body.toLowerCase().includes(needle)) {
      results.push({
        id: memory.shortId,
        kind: 'memory',
        roomId: 'personal',
        roomTitle: DEMO_ROOM_TITLE['personal']!,
        text: memory.body,
        meta: memory.shortId,
      });
    }
  }

  for (const [roomId, { memories }] of Object.entries(ROOM_MEMORIES)) {
    for (const memory of memories) {
      if (!memory.body.toLowerCase().includes(needle)) continue;
      results.push({
        id: memory.shortId,
        kind: 'memory',
        roomId,
        roomTitle: DEMO_ROOM_TITLE[roomId] ?? 'okänt rum',
        text: memory.body,
        meta: memory.shortId,
      });
    }
  }

  for (const entry of DEMO_HISTORY) {
    if (!entry.body.toLowerCase().includes(needle)) continue;
    results.push({
      id: entry.id,
      kind: 'event',
      roomId: 'personal',
      roomTitle: DEMO_ROOM_TITLE['personal']!,
      text: entry.body,
      meta: entry.when,
    });
  }

  return results;
}

/**
 * One of the six fixed Personal Compass principles.
 * Live path: `loadCompassFromApi` maps the `compass` field of GET /v1/profile.
 */
export interface CompassLine {
  key: string;
  label: string;
  text: string;
  /** `'default'` renders no id and no "senast ändrad" line — there is nothing behind it. */
  source: 'default' | 'personal';
  shortId: string | null;
}

/** Five defaults and one customised, so the screen demos both states at once. */
export const DEMO_COMPASS: CompassLine[] = [
  {
    key: 'directness',
    label: 'Var direkt',
    text: 'Var direkt. Säg det du menar utan att mjuka upp det i onödan.',
    source: 'default',
    shortId: null,
  },
  {
    key: 'no_performative_encouragement',
    label: 'Var inte uppmuntrande på förhand',
    text: 'Var inte uppmuntrande på förhand. Bekräftelse ska vara förtjänad, inte automatisk.',
    source: 'default',
    shortId: null,
  },
  {
    key: 'independent_conclusions',
    label: 'Bilda din egen uppfattning',
    text:
      'Bilda din egen uppfattning istället för att bara hålla med. Att hålla med ska betyda ' +
      'att argumentet faktiskt håller.',
    source: 'default',
    shortId: null,
  },
  {
    key: 'challenge_weak_arguments',
    label: 'Säg ifrån när ett resonemang inte håller',
    text: 'Säg ifrån direkt när ett resonemang inte håller, hellre än att låta det passera.',
    source: 'personal',
    shortId: 'p-cmp1',
  },
  {
    key: 'lead_with_problems',
    label: 'Lyft problemet före berömmet',
    text: 'Om något har en verklig brist eller risk, säg det först — inte efter beröm eller längst ner.',
    source: 'default',
    shortId: null,
  },
  {
    key: 'label_certainty',
    label: 'Skilj fakta, antagande och spekulation',
    text: 'Skilj på vad som är fakta, vad som är ett antagande och vad som är spekulation.',
    source: 'default',
    shortId: null,
  },
];
