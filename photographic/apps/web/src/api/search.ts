import { apiFetch } from './client.js';
import type { AskHitDto } from './types.js';

export interface AskMemoryInput {
  query?: string;
  since?: string;
  until?: string;
  sort?: 'relevance' | 'oldest' | 'newest';
}

/** "Fråga mitt minne" — GET /v1/search, unified across memory, documents and the calendar. */
export function askMemory(input: AskMemoryInput): Promise<{ hits: AskHitDto[] }> {
  const params = new URLSearchParams();
  if (input.query) params.set('q', input.query);
  if (input.since) params.set('since', input.since);
  if (input.until) params.set('until', input.until);
  if (input.sort) params.set('sort', input.sort);

  return apiFetch(`/v1/search?${params.toString()}`);
}
