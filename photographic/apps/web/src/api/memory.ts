import { apiFetch } from './client.js';
import type { ForgetResponse, ItemDto } from './types.js';

/** Soft-delete. Returns an undo token for the same-turn "ångra" affordance. */
export function forgetMemory(shortId: string, roomId?: string): Promise<ForgetResponse> {
  const query = roomId ? `?roomId=${encodeURIComponent(roomId)}` : '';
  return apiFetch(`/v1/memory/${encodeURIComponent(shortId)}${query}`, { method: 'DELETE' });
}

export function undoMemory(undoToken: string): Promise<{ item: ItemDto }> {
  return apiFetch('/v1/memory/undo', {
    method: 'POST',
    body: JSON.stringify({ undoToken }),
  });
}
