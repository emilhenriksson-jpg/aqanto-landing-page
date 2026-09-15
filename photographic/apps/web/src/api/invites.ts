import { apiFetch } from './client.js';
import type { InvitePreviewDto } from './types.js';

/** Unauthenticated: what a recipient sees before they have an account. */
export function getInvite(token: string): Promise<InvitePreviewDto> {
  return apiFetch(`/v1/invites/${encodeURIComponent(token)}`);
}
