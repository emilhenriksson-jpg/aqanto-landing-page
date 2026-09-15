import { apiFetch } from './client.js';
import type { ItemDto, TrashEntryDto } from './types.js';

/** Soft-deleted memories still recoverable — GET /v1/trash. */
export function listTrash(): Promise<{ entries: TrashEntryDto[]; retentionDays: number }> {
  return apiFetch('/v1/trash');
}

/** Restore from the trash shelf — POST /v1/trash/:shortId/restore. */
export function restoreTrash(
  shortId: string,
  roomId?: string,
): Promise<{ item: ItemDto }> {
  const query = roomId ? `?roomId=${encodeURIComponent(roomId)}` : '';
  return apiFetch(`/v1/trash/${encodeURIComponent(shortId)}/restore${query}`, {
    method: 'POST',
  });
}
