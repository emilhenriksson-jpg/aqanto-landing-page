import { apiFetch } from './client.js';
import type { ClientHealthDto } from './types.js';

/** Connected AI delivery lights — GET /v1/clients. */
export function listClients(): Promise<{ clients: ClientHealthDto[] }> {
  return apiFetch('/v1/clients');
}
