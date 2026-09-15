import { apiFetch } from './client.js';
import type { ItemDto, RoomDocumentDto, TrashEntryDto } from './types.js';

/** Everything still recoverable — memories and documents together. GET /v1/trash. */
export function listTrash(): Promise<{ entries: TrashEntryDto[]; retentionDays: number }> {
  return apiFetch('/v1/trash');
}

/**
 * Restore whatever the person is looking at — POST /v1/trash/:handle/restore.
 *
 * Takes the entry's `handle` rather than a short id, because the trash holds two kinds of
 * thing and they are addressed differently. The two id shapes cannot collide, so one route
 * serves both and this client needs no branch.
 */
export function restoreTrash(
  handle: string,
  roomId?: string,
): Promise<
  { type: 'memory'; item: ItemDto } | { type: 'document'; document: RoomDocumentDto }
> {
  const query = roomId ? `?roomId=${encodeURIComponent(roomId)}` : '';
  return apiFetch(`/v1/trash/${encodeURIComponent(handle)}/restore${query}`, {
    method: 'POST',
  });
}
