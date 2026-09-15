import { apiFetch } from './client.js';
import type { HistoryEntryDto } from './types.js';

/**
 * User-facing change log — GET /v1/history.
 *
 * `room` narrows it to one room, which is what a room's activity feed is: the same log,
 * asked a narrower question. Nothing here filters in the browser — the API resolves the
 * person's membership itself, so a room id in this call is a request and never an
 * authority.
 */
export function listHistory(
  options: { room?: string; limit?: number } = {},
): Promise<{ entries: HistoryEntryDto[] }> {
  const params = new URLSearchParams();
  if (options.room) params.set('room', options.room);
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return apiFetch(`/v1/history${query ? `?${query}` : ''}`);
}
