/**
 * Load room UI shapes from the REST API.
 *
 * Screens keep using the demo types in `demo.ts`; this file is the only place that
 * knows about wire DTOs. Shared-room item lists are not a REST endpoint yet — the
 * room GET returns brief + members — so memories stay empty and the UI shows its
 * calm empty copy rather than inventing a search scrape.
 */

import { PROFILE_TOKEN_BUDGET } from '@photographic/core';

import { ApiError, getInvite, getProfile, getRoom, listRooms } from '../api/index.js';
import type { ProfileSectionsDto, RoomMemberDto, RoomSummaryDto } from '../api/index.js';
import type { InvitePreviewData, MemoryLine, RoomCard, RoomDetail } from './demo.js';

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
    const { room, brief, members } = await getRoom(roomId);
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
      memories: [],
      tokenCount: brief.tokenCount,
      tokenCeiling: 0,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
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

export function calmErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return 'Du behöver vara inloggad för att se det här.';
    }
    return error.message || 'Kunde inte hämta just nu.';
  }
  return 'Kunde inte hämta just nu.';
}
