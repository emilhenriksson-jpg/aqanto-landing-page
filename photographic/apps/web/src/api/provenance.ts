import { apiFetch } from './client.js';
import type { ProvenanceDto } from './types.js';

/**
 * "Hur vet du det om mig?" for one memory — GET /v1/memory/:shortId/provenance.
 *
 * `roomId` only disambiguates the short id; it is not what decides access. A memory the
 * person may not read answers 404 either way, the same as one that does not exist.
 */
export function getProvenance(shortId: string, roomId?: string): Promise<ProvenanceDto> {
  const query = roomId ? `?roomId=${encodeURIComponent(roomId)}` : '';
  return apiFetch(`/v1/memory/${encodeURIComponent(shortId)}/provenance${query}`);
}
