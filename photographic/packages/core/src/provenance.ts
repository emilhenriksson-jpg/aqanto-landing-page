/**
 * The provenance model: what happened, what it meant, and why it was stored there.
 *
 * The log records mechanism. `item.created` is the same row whether a fact landed in
 * your private memory or in a room five other people read, and a person looking at their
 * day does not think in rows — they think "det sparades privat" and "det lades i
 * Buyersclub Ledning". This file is the only place that translation happens, so the
 * calendar, the history feed and the answer to "hur vet du det?" cannot disagree about
 * what an event was.
 */

import type {
  AgentClient,
  ItemKind,
  MemoryEventKind,
  MemorySource,
  RoomKind,
} from './domain.js';

/** Display order: the sequence a day is read in, and the order the spec lists them. */
export const MEMORY_EVENT_KINDS: readonly MemoryEventKind[] = [
  'saved_private',
  'saved_to_room',
  'shared',
  'updated',
  'moved',
  'deleted',
  'restored',
  'disputed',
];

/**
 * The log event types the calendar is a view over.
 *
 * An allowlist, for the same reason the history feed has one: proposals, purges, room
 * creation and membership changes are things that happened *around* the memory, and a
 * day that lists them buries the seven lines that answer "vad gjorde Photographic med
 * det jag berättade?". They stay visible in Historik, which is the screen for that.
 */
export const CALENDAR_EVENT_TYPES: readonly string[] = [
  'item.created',
  'item.updated',
  'item.superseded',
  'item.shared',
  'item.moved',
  'item.deleted',
  'item.restored',
  'item.disputed',
];

/**
 * Which of the seven an event was.
 *
 * `item.created` splits three ways, and the third is the interesting one. A creation
 * that supersedes an existing memory is a correction, not a new fact: it is the case the
 * scope describes as 15 oktober becoming 1 november, and showing it as "sparat" would
 * lose both the original and the fact that anything changed. The payload carries what it
 * replaced, so the day can show the correction and the value it corrected on one line.
 */
export function memoryEventKindOf(
  eventType: string,
  roomKind: RoomKind,
  payload: Record<string, unknown> = {},
): MemoryEventKind | null {
  switch (eventType) {
    case 'item.created':
      if (payload['supersedes']) return 'updated';
      return roomKind === 'personal' ? 'saved_private' : 'saved_to_room';
    case 'item.updated':
    case 'item.superseded':
      return 'updated';
    case 'item.shared':
      return 'shared';
    case 'item.moved':
      return 'moved';
    case 'item.deleted':
      return 'deleted';
    case 'item.restored':
      return 'restored';
    case 'item.disputed':
      return 'disputed';
    default:
      return null;
  }
}

/** Swedish display names for the clients, used inside derived motivations and labels. */
export function clientName(agentClient: AgentClient | null): string {
  if (!agentClient) return 'okänd klient';
  if (agentClient.startsWith('claude')) return 'Claude';
  if (agentClient.startsWith('chatgpt')) return 'ChatGPT';
  switch (agentClient) {
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    case 'voice':
      return 'Röstläget';
    case 'web':
      return 'Photographic';
    case 'api':
      return 'Photographics API';
    default:
      // Never a likely-looking default. A confident wrong attribution in someone's own
      // history is worse than an honest gap — the same reasoning the actor code already
      // applies to guessing a client's label from the name it chose for itself.
      return 'okänd klient';
  }
}

/** Clients that mean a person was talking to a model, rather than a script calling in. */
const CONVERSATIONAL: readonly AgentClient[] = [
  'claude-desktop',
  'claude-mobile',
  'claude-code',
  'chatgpt-web',
  'codex',
  'cursor',
  'voice',
];

/**
 * Where the information came from, when nobody said.
 *
 * Every write already carries enough to answer this honestly without a caller doing
 * anything: a client and a session ref is a conversation, and `web` with no session is
 * the person typing into the app. Deriving it rather than storing `unknown` is what keeps
 * "hur vet du det om mig?" answerable for memories saved before anyone thought about
 * provenance, which is most of them.
 */
export function deriveSource(input: {
  agentClient: AgentClient | null;
  sessionRef: string | null;
  documentId?: string | null;
  documentName?: string | null;
  importedFrom?: string | null;
}): MemorySource {
  if (input.documentId) {
    return {
      kind: 'document',
      label: input.documentName?.trim() || 'Ett dokument',
      ref: input.documentId,
      uri: null,
    };
  }

  if (input.importedFrom) {
    return {
      kind: 'import',
      label: `Importerat från ${input.importedFrom}`,
      ref: input.importedFrom,
      uri: null,
    };
  }

  if (input.agentClient === 'web') {
    return { kind: 'manual', label: 'Du, i Photographic', ref: null, uri: null };
  }

  if (input.agentClient && CONVERSATIONAL.includes(input.agentClient)) {
    return {
      kind: 'conversation',
      label: `Samtal med ${clientName(input.agentClient)}`,
      ref: input.sessionRef,
      uri: null,
    };
  }

  // `api` and anything unrecognised are not conversations, and saying they were would be
  // inventing a place the information came from.
  return {
    kind: 'unknown',
    label: input.agentClient ? `Skrivet via ${clientName(input.agentClient)}` : 'Okänd källa',
    ref: input.sessionRef,
    uri: null,
  };
}

/**
 * Why it was stored there, when the caller did not say.
 *
 * Every automatic action owes the person a sentence they can read, and a model that
 * forgot to write one must not turn into a blank. Deterministic rather than summarised,
 * because this runs on the write path: a model call per save is latency a voice turn
 * cannot absorb, and a caller who has something better to say can always pass it.
 */
export function deriveMotivation(input: {
  kind: MemoryEventKind;
  itemKind?: ItemKind;
  roomTitle: string;
  roomKind: RoomKind;
  fromRoomTitle?: string | null;
  explicit?: boolean;
}): string {
  const room = input.roomTitle.trim() || 'rummet';

  switch (input.kind) {
    case 'saved_private':
      return input.itemKind === 'instruction'
        ? 'Styr hur dina AI:er svarar, så det hör hemma i ditt privata minne.'
        : 'Handlar om dig, och sparas därför bara privat.';
    case 'saved_to_room':
      return `Hör till ${room} snarare än till ditt privata minne.`;
    case 'shared':
      return `Delades i ${room} efter att du bekräftat det.`;
    case 'moved':
      return input.fromRoomTitle
        ? `Flyttat från ${input.fromRoomTitle} till ${room}, där det hör hemma.`
        : `Flyttat till ${room}, där det hör hemma.`;
    case 'updated':
      return 'Uppgiften stämde inte längre. Den gamla finns kvar i historiken.';
    case 'deleted':
      return 'Togs bort. Ligger kvar i papperskorgen i 30 dagar.';
    case 'restored':
      return 'Hämtat tillbaka från papperskorgen.';
    case 'disputed':
      return `Två uppgifter i ${room} säger olika saker. Ingen av dem har ändrats — du avgör vilken som gäller.`;
  }
}
