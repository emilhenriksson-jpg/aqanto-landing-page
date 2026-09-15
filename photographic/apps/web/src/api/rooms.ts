import { apiFetch } from './client.js';
import type { BriefDto, RoomDto, RoomMemberDto, RoomSummaryDto } from './types.js';

export function listRooms(): Promise<{ rooms: RoomSummaryDto[] }> {
  return apiFetch('/v1/rooms');
}

export function getRoom(roomId: string): Promise<{
  room: RoomDto;
  brief: BriefDto;
  members: RoomMemberDto[];
}> {
  return apiFetch(`/v1/rooms/${encodeURIComponent(roomId)}`);
}
