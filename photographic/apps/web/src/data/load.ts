/**
 * Load room UI shapes from the REST API.
 *
 * Screens keep using the demo types in `demo.ts`; this file is the only place that
 * knows about wire DTOs. Shared-room memories come from `GET /v1/rooms/:id/items`
 * (room GET is brief + members only). Documents come from `GET /v1/rooms/:id/documents`.
 */

import { PROFILE_TOKEN_BUDGET } from '@photographic/core';

import {
  ApiError,
  askMemory,
  getCalendarDay,
  getCalendarEvent,
  getInvite,
  getProfile,
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
  MemoryEventDetailDto,
  ProfileSectionsDto,
  ProposalDto,
  RoomDocumentDto,
  RoomItemDto,
  RoomMemberDto,
  RoomSummaryDto,
  HistoryEntryDto,
  TrashEntryDto,
} from '../api/index.js';
import type {
  ApprovalItem,
  AskResultLine,
  DayEvent,
  DayView,
  DemoClient,
  DocumentLine,
  InvitePreviewData,
  MemoryLine,
  RoomCard,
  RoomDetail,
  HistoryLine,
  TrashLine,
} from './demo.js';

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

    const memberNames = members
      .map((member) => memberDisplayName(member))
      .filter((name): name is string => Boolean(name));

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

function memberDisplayName(member: RoomMemberDto): string | null {
  const name = member.displayName?.trim();
  return name && name.length > 0 ? name : null;
}

export async function loadInviteFromApi(token: string): Promise<InvitePreviewData | null> {
  try {
    const dto = await getInvite(token);
    return mapInvitePreview(token, dto);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function mapInvitePreview(
  token: string,
  dto: {
    room: { title: string; description: string | null };
    invitedByName: string | null;
    preview: string | null;
  },
): InvitePreviewData {
  return {
    token,
    roomTitle: dto.room.title,
    brief: dto.room.description,
    invitedByName: dto.invitedByName?.trim() || 'Någon',
    lines: previewLines(dto.preview),
  };
}

function previewLines(preview: string | null): MemoryLine[] {
  if (!preview) return [];
  return preview
    .split('\n')
    .map((body) => body.trim())
    .filter((body) => body.length > 0)
    .map((body, index) => ({
      shortId: `i-${index + 1}`,
      kind: 'note' as const,
      body,
    }));
}

export function mapClientHealth(dto: ClientHealthDto): DemoClient {
  const method = dto.deliveryMethod;
  return {
    id: dto.agentClient,
    displayName: dto.displayName,
    lastSeenAt: dto.lastSeenAt,
    profileDelivered: dto.profileDelivered,
    deliveryMethod:
      method === 'mcp_instructions' || method === 'tool_call' ? method : method ? 'tool_call' : null,
    degraded: dto.degraded,
  };
}

export async function loadClientsFromApi(): Promise<DemoClient[]> {
  const { clients } = await listClients();
  return clients.map(mapClientHealth);
}

export function mapProposal(dto: ProposalDto): ApprovalItem {
  return {
    id: dto.id,
    clientLabel: clientLabel(dto.proposedByClient),
    kind: mapItemKind(dto.kind),
    body: dto.body,
    reason: dto.reason,
  };
}

export async function loadApprovalsFromApi(): Promise<ApprovalItem[]> {
  const { proposals } = await listProposals();
  return proposals.map(mapProposal);
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

  return {
    shortId: dto.shortId,
    roomTitle: dto.roomTitle,
    body: dto.body,
    daysLabel,
    deleteReason: dto.deleteReason,
  };
}


export async function loadTrashFromApi(): Promise<TrashLine[]> {
  const { entries } = await listTrash();
  return entries.map(mapTrashEntry);
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
};

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
  const who = historyWho(dto);
  const verb = HISTORY_ACTION[dto.action] ?? dto.action;
  const head = `${who} ${verb}`;

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
