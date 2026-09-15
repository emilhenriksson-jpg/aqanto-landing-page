import { apiFetch } from './client.js';
import type { ItemDto, ProposalDto } from './types.js';

/** Pending proposals waiting for a tap — GET /v1/memory/proposals. */
export function listProposals(): Promise<{ proposals: ProposalDto[] }> {
  return apiFetch('/v1/memory/proposals');
}

/** Accept or dismiss a proposal — POST /v1/memory/proposals/:id. */
export function resolveProposal(
  id: string,
  accept: boolean,
): Promise<{ accepted: boolean; item: ItemDto | null }> {
  return apiFetch(`/v1/memory/proposals/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ accept }),
  });
}
