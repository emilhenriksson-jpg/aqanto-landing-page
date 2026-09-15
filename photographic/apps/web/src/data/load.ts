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
  ClientHealthDto,
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
    /** Quiet Swedish shelf label — not a file-manager extension chip. */
    meta: 'Dokument',
  };
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


export function mapHistoryEntry(dto: HistoryEntryDto): HistoryLine {
  const when = relativeSwedish(dto.occurredAt);
  const who = dto.actorName?.trim() || clientLabel(dto.agentClient);
  const what = dto.body?.trim() || dto.action;
  const verb =
    dto.action === 'deleted' || dto.action === 'purged'
      ? 'tog bort'
      : dto.action === 'approved' || dto.wasApproved
        ? 'godkände'
        : 'sparade';
  return {
    id: String(dto.seq),
    when,
    body: `${who} ${verb} ${what}`,
  };
}

export async function loadHistoryFromApi(): Promise<HistoryLine[]> {
  const { entries } = await listHistory();
  return entries.map(mapHistoryEntry);
}

function relativeSwedish(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'Nyligen';
  const hours = Math.max(0, Math.round((Date.now() - then) / 3_600_000));
  if (hours < 1) return 'Nyss';
  if (hours < 24) return hours === 1 ? '1 timme sedan' : `${hours} timmar sedan`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Igår';
  if (days < 7) return `${days} dagar sedan`;
  return 'Förra veckan';
}

export async function loadTrashFromApi(): Promise<TrashLine[]> {
  const { entries } = await listTrash();
  return entries.map(mapTrashEntry);
}

function clientLabel(agentClient: string | null): string {
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
