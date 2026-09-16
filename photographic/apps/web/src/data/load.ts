/**
 * Load room UI shapes from the REST API.
 *
 * Screens keep using the demo types in `demo.ts`; this file is the only place that
 * knows about wire DTOs. Shared-room memories come from `GET /v1/rooms/:id/items`
 * (room GET is brief + members only). Documents come from `GET /v1/rooms/:id/documents`.
 */

import type { CompassPrincipleKey } from '@photographic/core';
import { compassPrincipleLabel, PROFILE_TOKEN_BUDGET } from '@photographic/core';

import {
  ApiError,
  askMemory,
  getAccount,
  getCalendarDay,
  getCalendarEvent,
  getDeletionState,
  getProfile,
  getProvenance,
  getRoom,
  listClients,
  listProposals,
  listRoomDocuments,
  listRoomItems,
  listRooms,
  listHistory,
  listTrash,
} from '../api/index.js';
import type {
  AskHitDto,
  AskMemoryInput,
  CalendarDayDto,
  CalendarEntryDto,
  ClientHealthDto,
  CompassEntryDto,
  EmbeddingProvenanceDto,
  MemoryEventDetailDto,
  ProfileSectionsDto,
  ProposalDto,
  ProvenanceDto,
  RoomDocumentDto,
  RoomItemDto,
  RoomMemberDto,
  RoomSummaryDto,
  HistoryEntryDto,
  TrashEntryDto,
} from '../api/index.js';
import type {
  ActivityLine,
  ApprovalItem,
  AskResultLine,
  CompassLine,
  DayEvent,
  DayView,
  DemoClient,
  DocumentLine,
  MemoryLine,
  ProvenanceAnswer,
  RoomCard,
  RoomDetail,
  HistoryLine,
  TrashLine,
} from './demo.js';

export interface AccountView {
  firstName: string | null;
}

export async function loadAccountFromApi(): Promise<AccountView> {
  const account = await getAccount();
  return { firstName: account.firstName };
}

export function mapRoomSummary(summary: RoomSummaryDto): RoomCard {
  return {
    id: summary.roomId,
    kind: summary.kind,
    title: summary.kind === 'personal' ? summary.title || 'Ditt rum' : summary.title,
    headline:
      summary.oneLine ||
      (summary.kind === 'personal'
        ? 'Det Claude och ChatGPT läser om dig innan de svarar'
        : 'Inget sparat än'),
    memberCount: summary.memberCount,
    memberNames: [],
    unseenCount: summary.unseenCount,
  };
}

export async function loadRoomsFromApi(): Promise<RoomCard[]> {
  const { rooms } = await listRooms();
  const cards = rooms.map(mapRoomSummary);
  cards.sort((a, b) => {
    if (a.kind === b.kind) return 0;
    return a.kind === 'personal' ? -1 : 1;
  });
  return cards;
}

export async function loadPersonalRoomFromApi(): Promise<RoomDetail> {
  const [{ rooms }, { profile }] = await Promise.all([listRooms(), getProfile()]);
  const personal = rooms.find((room) => room.kind === 'personal');
  if (!personal) {
    throw new ApiError('Ditt rum hittades inte.', 404);
  }

  return {
    ...mapRoomSummary(personal),
    brief: null,
    memories: memoriesFromProfile(profile.sections),
    tokenCount: profile.tokenCount,
    tokenCeiling: PROFILE_TOKEN_BUDGET,
  };
}

export async function loadSharedRoomFromApi(roomId: string): Promise<RoomDetail | null> {
  try {
    const [{ room, brief, members }, { items }] = await Promise.all([
      getRoom(roomId),
      listRoomItems(roomId),
    ]);
    if (room.kind === 'personal') return null;

    // Other members, not the viewer themselves — "delad med" already means "with other
    // people", and `isSelf` is computed server-side so the client never has to guess
    // its own identity to tell the two apart.
    const memberNames = members.filter((member) => !member.isSelf).map(memberDisplayName);

    return {
      id: room.id,
      kind: 'shared',
      title: room.title,
      headline: room.description || brief.rendered || 'Inget sparat än',
      memberCount: members.length,
      memberNames,
      unseenCount: 0,
      brief: brief.rendered || room.description || null,
      memories: items.map(mapRoomItem),
      tokenCount: brief.tokenCount,
      tokenCeiling: 0,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function mapRoomItem(item: RoomItemDto): MemoryLine {
  return {
    shortId: item.shortId,
    kind: mapItemKind(item.kind),
    body: item.body,
  };
}

function memoriesFromProfile(sections: ProfileSectionsDto): MemoryLine[] {
  const lines: MemoryLine[] = [];
  pushSection(lines, sections.identity, 'identity');
  pushSection(lines, sections.hardFacts, 'fact');
  pushSection(lines, sections.preferences, 'preference');
  pushSection(lines, sections.instructions, 'instruction');
  pushSection(lines, sections.never, 'never');
  // Profile collapses decision + note into currentFocus.
  pushSection(lines, sections.currentFocus, 'note');
  return lines;
}

function pushSection(
  out: MemoryLine[],
  items: Array<{ shortId: string; body: string }>,
  kind: MemoryLine['kind'],
): void {
  for (const item of items) {
    out.push({ shortId: item.shortId, kind, body: item.body });
  }
}

/**
 * A member's name for display, falling back to "Någon" — the same word every other
 * unknown-person surface uses (invites, disputes, provenance) — rather than dropping
 * the member from the list or leaving a blank. A shared room member with no name set
 * yet is still a person the room is shared with, and hiding them undercounts who is
 * actually there.
 */
function memberDisplayName(member: RoomMemberDto): string {
  const name = member.displayName?.trim();
  return name && name.length > 0 ? name : 'Någon';
}

export function mapClientHealth(dto: ClientHealthDto): DemoClient {
  const method = dto.deliveryMethod;
  return {
    // `clientId` when we have one, because several DCR clients share `agentClient: unknown`
    // and a list keyed on that name would render one row for all of them.
    id: dto.clientId ?? dto.agentClient,
    displayName: dto.displayName,
    lastSeenAt: dto.lastSeenAt,
    profileDelivered: dto.profileDelivered,
    deliveryMethod:
      method === 'mcp_instructions' || method === 'tool_call' ? method : method ? 'tool_call' : null,
    degraded: dto.degraded,
    revoked: dto.revoked,
  };
}

export async function loadClientsFromApi(): Promise<DemoClient[]> {
  const { clients } = await listClients();
  return clients.map(mapClientHealth);
}

/**
 * A proposal as a decision, not as a notification.
 *
 * `roomId` and `intent` used to be dropped here, which is how the queue ended up
 * rendering "vill spara" over a request to put something in front of three other people.
 * They are the two fields that decide what the card says, so they survive the mapping.
 */
interface ApprovalRoom {
  title: string;
  kind: 'personal' | 'shared';
  audience: string[];
  audienceCount: number;
}

export function mapProposal(
  dto: ProposalDto,
  rooms: Map<string, ApprovalRoom> = new Map(),
): ApprovalItem {
  const room = rooms.get(dto.roomId);
  return {
    id: dto.id,
    clientLabel: clientLabel(dto.proposedByClient),
    intent: dto.intent ?? 'remember',
    kind: mapItemKind(dto.kind),
    body: dto.body,
    reason: dto.reason,
    roomId: dto.roomId,
    roomTitle: room?.title ?? null,
    roomKind: room?.kind ?? null,
    audience: room?.audience ?? [],
    audienceCount: room?.audienceCount ?? 1,
    createdAt: dto.createdAt,
  };
}

/**
 * The queue, with enough context to answer it.
 *
 * Rooms are fetched alongside so a card can name where the memory lands, and the members
 * of any shared room in the queue are fetched by name — "kan läsas av Anna och Jacob" is
 * the one fact a person actually needs to answer a sharing request, and a room id is not
 * it. Both lookups are allowed to fail: a card with less context still beats no card.
 */
export async function loadApprovalsFromApi(): Promise<ApprovalItem[]> {
  const { proposals } = await listProposals();
  if (proposals.length === 0) return [];

  const rooms = await approvalRoomContext(proposals);
  return proposals.map((dto) => mapProposal(dto, rooms));
}

async function approvalRoomContext(proposals: ProposalDto[]): Promise<Map<string, ApprovalRoom>> {
  const context = new Map<string, ApprovalRoom>();

  let summaries: RoomSummaryDto[];
  try {
    summaries = (await listRooms()).rooms;
  } catch {
    return context;
  }

  const wanted = new Set(proposals.map((p) => p.roomId));
  for (const summary of summaries) {
    if (!wanted.has(summary.roomId)) continue;
    context.set(summary.roomId, {
      title: summary.kind === 'personal' ? summary.title || 'Ditt rum' : summary.title,
      kind: summary.kind,
      audience: [],
      audienceCount: summary.memberCount,
    });
  }

  const shared = [...context.entries()].filter(([, room]) => room.kind === 'shared');
  await Promise.all(
    shared.map(async ([roomId, room]) => {
      try {
        const { members } = await getRoom(roomId);
        const names = members
          .map((member) => memberDisplayName(member))
          .filter((name): name is string => Boolean(name));
        room.audienceCount = members.length;
        // All of them or none. A list that quietly omits the two members who never
        // entered a name would understate who can read it, which is the one direction
        // this line must never be wrong in.
        room.audience = names.length === members.length ? names : [];
      } catch {
        // Names are an improvement on the card, never a precondition for it.
      }
    }),
  );

  return context;
}

/**
 * The provenance endpoint, turned into sentences a person reads.
 *
 * Formatting happens here rather than in the component for the same reason every other
 * mapping does: the screen should not know that `savedByClient` is `"claude-desktop"`,
 * and "Claude" is the only spelling the person should ever meet.
 */
export function mapProvenance(
  dto: ProvenanceDto,
  roomKind: RoomDetail['kind'] = 'personal',
): ProvenanceAnswer {
  return {
    shortId: dto.shortId,
    when: swedishMomentSwedish(dto.savedAt),
    who: historyWho({ agentClient: dto.savedByClient, actorName: null }),
    sourceLabel: dto.source?.label?.trim() || null,
    roomTitle: dto.roomTitle,
    roomKind,
    motivation: dto.motivation?.trim() || null,
    approvedByName: dto.approvedByName?.trim() || null,
    changed: dto.changed,
    modelReach: modelReachSentence(dto.embedding),
    // The event that created it, which is where the zoom to the original source lives.
    // `shared` counts: a memory that arrived in a room by being shared was created by
    // that act as far as the person is concerned.
    seq: dto.timeline.find((entry) => entry.action === 'saved' || entry.action === 'shared')?.seq ?? null,
  };
}

export async function loadProvenanceFromApi(
  shortId: string,
  roomId?: string,
  roomKind: RoomDetail['kind'] = 'personal',
): Promise<ProvenanceAnswer> {
  return mapProvenance(await getProvenance(shortId, roomId), roomKind);
}

/**
 * "Har min text skickats någonstans?", answered about this memory.
 *
 * Part of the same question as the rest of the panel, and the part a person is least
 * able to find out any other way. Only stated when the server recorded an answer:
 * `undefined` is a server that predates the field and `null` is a memory with no vector,
 * and neither of those is a "nej" we are entitled to print.
 */
export function modelReachSentence(embedding: EmbeddingProvenanceDto | null | undefined): string | null {
  if (!embedding) return null;

  const when = swedishDateSwedish(embedding.at);
  if (!embedding.external) {
    return `Nej — sökindexet räknades ut här (${embedding.model}).`;
  }
  return (
    `Ja — skickad till ${providerName(embedding.provider)} (${embedding.model}) ${when}, ` +
    'för att kunna hittas på betydelse. Modellen tränas inte på den.'
  );
}

/** The company's own spelling, not the config value. */
function providerName(provider: string): string {
  return provider === 'openai' ? 'OpenAI' : provider;
}

/** "2 september 2026" — a day, without a time nobody asked for. */
export function swedishDateSwedish(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** "2 september 2026 kl 09:14", the way a date is said out loud. */
export function swedishMomentSwedish(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' });
  const time = date.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  return `${day} kl ${time}`;
}

export function mapRoomDocument(dto: RoomDocumentDto): DocumentLine {
  return {
    id: dto.id,
    title: dto.filename,
    meta: documentMeta(dto),
    searchable: dto.searchable,
  };
}

/**
 * The quiet line under a filename.
 *
 * Says when a document is not searchable, because otherwise a scanned PDF sits on the
 * shelf looking exactly like every other row and a person has no way to know their AI
 * cannot read it. Size rather than a file-type chip: the type is already in the name.
 */
function documentMeta(dto: RoomDocumentDto): string {
  if (!dto.searchable) return `${dto.byteSizeLabel} · kan inte läsas som text`;

  const pages = dto.pageCount && dto.pageCount > 1 ? `${dto.pageCount} sidor · ` : '';
  return `${pages}${dto.byteSizeLabel}`;
}

export async function loadDocumentsFromApi(roomId: string): Promise<DocumentLine[]> {
  const { documents } = await listRoomDocuments(roomId);
  return documents.map(mapRoomDocument);
}

export function mapTrashEntry(dto: TrashEntryDto): TrashLine {
  const days = dto.daysRemaining;
  const daysLabel =
    days <= 0 ? 'Försvinner snart' : days === 1 ? '1 dag kvar' : `${days} dagar kvar`;

  // A document is named by its filename and a memory by its text. Both go in `body` because
  // both answer "what was this", and `type` is what tells the row how to present it.
  return {
    type: dto.type,
    handle: dto.handle,
    shortId: dto.type === 'memory' ? dto.shortId : null,
    roomTitle: dto.roomTitle,
    body: dto.type === 'document' ? dto.filename : dto.body,
    daysLabel,
    deleteReason: dto.deleteReason,
  };
}


export async function loadTrashFromApi(): Promise<TrashLine[]> {
  const { entries } = await listTrash();
  return entries.map(mapTrashEntry);
}

/**
 * Whether this account is already on its way out.
 *
 * The account screen asks, because a person who requested deletion during a holiday and
 * came back should be told from the screen that mentions their account rather than having
 * to open the deletion page to find out how long is left.
 */
export interface AccountState {
  deletion: { daysRemaining: number; immediate: boolean } | null;
  firstName: string | null;
}

/**
 * The whole account screen in one read: the name, and whether a deletion is pending.
 *
 * Both in parallel and both required. They arrived as two screens on two branches, each
 * with its own loader, and `/konto` can only render one — so the fetch is one call rather
 * than a screen that knows which half it is.
 */
export async function loadAccountStateFromApi(): Promise<AccountState> {
  // The name is fetched alongside but cannot take the screen down with it. Export and
  // permanent deletion are why this screen exists, and they were unreachable for weeks;
  // making them depend on a second endpoint would be a new way to lose them. A name that
  // fails to load reads as "not set yet", which is a state the field already handles.
  const [deletionState, account] = await Promise.all([
    getDeletionState(),
    getAccount().catch(() => ({ firstName: null })),
  ]);
  const pending = deletionState.pending;

  return {
    deletion: pending
      ? { daysRemaining: pending.daysRemaining, immediate: pending.immediate }
      : null,
    firstName: account.firstName,
  };
}

const HISTORY_ACTION: Record<string, string> = {
  saved: 'sparade',
  updated: 'ändrade',
  superseded: 'ersatte',
  shared: 'delade',
  moved: 'flyttade',
  deleted: 'tog bort',
  restored: 'tog tillbaka',
  purged: 'raderade permanent',
  disputed: 'bestred',
  dispute_resolved: 'avgjorde tvisten om',
  proposed: 'föreslog',
  approved: 'godkände',
  rejected: 'avslog',
  document_added: 'lade till ett dokument',
  room_created: 'skapade rummet',
  member_joined: 'gick med',
  member_left: 'lämnade',
  // Said without the word "nödinloggning" needing explaining: what happened, and that it
  // happened on the server rather than in a browser. Not verbs, because nobody in the
  // sentence is a client or a person — see `STANDALONE_ACTIONS`.
  break_glass_minted: 'nödinloggning skapad på servern',
  break_glass_used: 'nödinloggning använd för att logga in',
};

/**
 * Actions whose line is a sentence of its own.
 *
 * Every other entry reads "<vem> <gjorde> <vad>", which works because a memory was
 * changed by somebody. An emergency sign-in has no such subject: the mint is a script on
 * the machine, and prefixing the enum's client name would produce "api nödinloggning
 * skapad". So these two carry the whole statement and are capitalised instead.
 */
const STANDALONE_ACTIONS = new Set(['break_glass_minted', 'break_glass_used']);

/**
 * The person's own timezone, asked of the browser.
 *
 * A day is the unit of the calendar, so where a day starts matters: a memory saved at
 * 23:40 belongs to that evening. The API takes the zone rather than assuming one, and
 * this is the only place that decides which to send.
 */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** "tisdag 15 september 2026", as a person reads a date. */
export function swedishDayHeading(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('sv-SE', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function mapDayEvent(dto: CalendarEntryDto, timeZone?: string): DayEvent {
  return {
    seq: dto.seq,
    kind: dto.kind,
    time: new Date(dto.occurredAt).toLocaleTimeString('sv-SE', {
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }),
    shortId: dto.shortId,
    body: dto.body,
    previousBody: dto.previousBody,
    roomTitle: dto.provenance.roomTitle,
    fromRoomTitle: dto.fromRoomTitle,
    who: historyWho({
      agentClient: dto.provenance.agentClient,
      actorName: dto.provenance.actorName,
    }),
    motivation: dto.provenance.motivation,
    sourceLabel: dto.provenance.source?.label ?? null,
    sharedWith: (dto.sharedWith ?? [])
      .map((who) => who.name?.trim())
      .filter((name): name is string => Boolean(name)),
    disputes: dto.disputes ?? [],
    byOtherMember: dto.byOtherMember,
    changed: dto.provenance.changed,
    redacted: dto.redacted,
  };
}

export function mapDay(dto: CalendarDayDto): DayView {
  return {
    date: dto.date,
    heading: swedishDayHeading(dto.date),
    roomTitle: dto.roomTitle,
    events: dto.entries.map((entry) => mapDayEvent(entry, dto.timeZone)),
    byOthersCount: dto.byOthersCount,
    previousDate: dto.previousDate,
    nextDate: dto.nextDate,
  };
}

export async function loadDayFromApi(date: string, roomId?: string): Promise<DayView> {
  const timeZone = browserTimeZone();
  return mapDay(
    await getCalendarDay({
      date,
      ...(timeZone ? { timeZone } : {}),
      ...(roomId ? { roomId } : {}),
    }),
  );
}

export function loadEventFromApi(seq: number): Promise<MemoryEventDetailDto> {
  return getCalendarEvent(seq);
}

export function mapHistoryEntry(dto: HistoryEntryDto, now = new Date()): HistoryLine {
  const verb = HISTORY_ACTION[dto.action] ?? dto.action;
  const head = STANDALONE_ACTIONS.has(dto.action)
    ? `${verb.charAt(0).toUpperCase()}${verb.slice(1)}`
    : `${historyWho(dto)} ${verb}`;

  let detail = '';
  if (dto.redacted) {
    detail = '(texten är permanent raderad)';
  } else if (dto.body?.trim()) {
    detail = dto.body.replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  return {
    id: String(dto.seq),
    when: relativeWhenSwedish(dto.occurredAt, now),
    body: detail ? `${head} ${detail}` : head,
  };
}

export async function loadHistoryFromApi(): Promise<HistoryLine[]> {
  const { entries } = await listHistory();
  return entries.map((entry) => mapHistoryEntry(entry));
}

/**
 * A shared room's activity feed, from the log rather than from fixtures.
 *
 * `DESIGN.md` puts this feed in the room so a person feels located rather than like they
 * opened a table, and it read `DEMO_ACTIVITY` unconditionally — keyed by slug against real
 * UUIDs, so every real room's feed was permanently empty and said "Ingen aktivitet ännu"
 * about rooms with years in them. The event log already answers this question for
 * `/historik` and the calendar; this asks it about one room.
 *
 * Twelve entries, because it is a feed and not an audit trail — the audit trail is
 * `/historik`, and the calendar is the day-by-day view.
 */
export async function loadRoomActivityFromApi(
  roomId: string,
  limit = 12,
): Promise<ActivityLine[]> {
  const { entries } = await listHistory({ room: roomId, limit });
  return entries.map((entry) => mapHistoryEntry(entry));
}

/** "Fråga mitt minne" — GET /v1/search, mapped onto the same shape the demo path uses. */
export async function searchMemoryFromApi(input: AskMemoryInput): Promise<AskResultLine[]> {
  const { hits } = await askMemory(input);
  return hits.map(mapAskHit);
}

function mapAskHit(dto: AskHitDto): AskResultLine {
  const id =
    dto.shortId ?? dto.documentId ?? (dto.seq !== null ? String(dto.seq) : `${dto.roomId}-${dto.text.slice(0, 8)}`);

  return {
    id,
    kind: dto.kind,
    roomId: dto.roomId,
    roomTitle: dto.roomTitle || 'okänt rum',
    text: dto.text,
    meta: askHitMeta(dto),
  };
}

function askHitMeta(dto: AskHitDto, now = new Date()): string {
  if (dto.kind === 'event') {
    const verb = dto.action ? (HISTORY_ACTION[dto.action] ?? dto.action) : 'hände';
    return dto.occurredAt ? `${relativeWhenSwedish(dto.occurredAt, now)} · ${verb}` : verb;
  }
  return dto.shortId ?? (dto.kind === 'document' ? 'ur ett dokument' : 'utan id');
}

/**
 * Who did it, as a person would say it.
 *
 * `web` is the person themselves, so it reads "Du" rather than "Photographic" — being
 * told the app did something you did yourself is the kind of small wrongness that makes a
 * history feel untrustworthy.
 */
export function mapCompassEntry(dto: CompassEntryDto): CompassLine {
  return {
    key: dto.key,
    label: compassPrincipleLabel(dto.key as CompassPrincipleKey),
    text: dto.text,
    source: dto.source,
    shortId: dto.shortId,
  };
}

/** Always six entries — see `compassEntriesFrom` in `@photographic/core`. */
export async function loadCompassFromApi(): Promise<CompassLine[]> {
  const { profile } = await getProfile();
  return profile.compass.map(mapCompassEntry);
}

function historyWho(dto: { agentClient: string | null; actorName: string | null }): string {
  if (dto.agentClient === 'web' || dto.agentClient === 'voice') return 'Du';
  if (dto.agentClient) return clientLabel(dto.agentClient);
  if (dto.actorName?.trim()) return dto.actorName.trim();
  return 'Någon';
}

function relativeWhenSwedish(iso: string, now: Date): string {
  const then = new Date(iso);
  const ms = Math.max(0, now.getTime() - then.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Nyss';
  if (minutes < 60) return minutes === 1 ? '1 minut sedan' : `${minutes} minuter sedan`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 timme sedan' : `${hours} timmar sedan`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Igår';
  if (days < 7) return `${days} dagar sedan`;
  if (days < 14) return 'Förra veckan';
  return then.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
}

/**
 * The name a person would use, never the enum value.
 *
 * "claude-desktop" is what the wire says and "Claude" is what the design says: never say
 * "AI" to the user when a specific name works.
 */
export function clientLabel(agentClient: string | null): string {
  if (!agentClient) return 'En modell';
  if (agentClient.startsWith('claude')) return 'Claude';
  if (agentClient.startsWith('chatgpt')) return 'ChatGPT';
  if (agentClient === 'codex') return 'Codex';
  if (agentClient === 'cursor') return 'Cursor';
  if (agentClient === 'voice') return 'Röst';
  return agentClient;
}

function mapItemKind(kind: string): MemoryLine['kind'] {
  switch (kind) {
    case 'identity':
    case 'fact':
    case 'preference':
    case 'instruction':
    case 'never':
    case 'decision':
    case 'note':
      return kind;
    default:
      return 'note';
  }
}

export function calmErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return 'Du behöver vara inloggad för att se det här.';
    }
    return error.message || 'Kunde inte hämta just nu.';
  }
  return 'Kunde inte hämta just nu.';
}
