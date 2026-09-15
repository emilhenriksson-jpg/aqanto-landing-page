import { apiFetch } from './client.js';
import type { ProfileDto } from './types.js';

export function getProfile(): Promise<{ profile: ProfileDto }> {
  return apiFetch('/v1/profile');
}
