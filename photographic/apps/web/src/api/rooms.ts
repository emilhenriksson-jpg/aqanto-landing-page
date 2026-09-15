import { apiFetch, apiUpload } from './client.js';
import type {
  BriefDto,
  RoomDocumentDto,
  StorageDto,
  RoomDto,
  RoomItemDto,
  RoomMemberDto,
  RoomSummaryDto,
} from './types.js';

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

/** Active memories in a room — shortId / kind / body for the shared-room screen. */
export function listRoomItems(roomId: string): Promise<{ items: RoomItemDto[] }> {
  return apiFetch(`/v1/rooms/${encodeURIComponent(roomId)}/items`);
}

/** Documents in a room — the card fields for the Dokument shelf, never the contents. */
export function listRoomDocuments(roomId: string): Promise<{ documents: RoomDocumentDto[] }> {
  return apiFetch(`/v1/rooms/${encodeURIComponent(roomId)}/documents`);
}

/**
 * Uploads a file into a room.
 *
 * `FormData` rather than JSON, so `apiFetch` is bypassed: it sets a JSON content type,
 * and multipart needs the browser to write the boundary itself. Setting
 * `content-type` by hand here is the classic way to get a body the server cannot parse.
 */
export async function uploadRoomDocument(
  roomId: string,
  file: File,
): Promise<{ document: RoomDocumentDto; extraction: string; chunkCount: number }> {
  const body = new FormData();
  body.set('file', file);

  return apiUpload(`/v1/rooms/${encodeURIComponent(roomId)}/documents`, body);
}

/** How much of the 10 GB limit is used. */
export function getStorage(): Promise<{ storage: StorageDto }> {
  return apiFetch('/v1/storage');
}
