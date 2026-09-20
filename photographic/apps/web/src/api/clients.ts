import { apiFetch } from './client.js';
import type { ClientHealthDto } from './types.js';

/** Connected AI delivery lights — GET /v1/clients. */
export function listClients(): Promise<{ clients: ClientHealthDto[] }> {
  return apiFetch('/v1/clients');
}

export function setChatgptLaunch(clientId: string, link: string): Promise<{ clientId: string; chatgptPluginId: string }> {
  return apiFetch(`/v1/clients/${encodeURIComponent(clientId)}/chatgpt-launch`, { method: 'PATCH', body: JSON.stringify({ link }) });
}
