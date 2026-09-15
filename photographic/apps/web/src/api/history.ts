import { apiFetch } from './client.js';
import type { HistoryEntryDto } from './types.js';

/** User-facing change log — GET /v1/history. */
export function listHistory(): Promise<{ entries: HistoryEntryDto[] }> {
  return apiFetch('/v1/history');
}
