import { apiFetch } from './client.js';
import type { AccountDto } from './types.js';

/** The person's own first name, or that there isn't one yet. */
export function getAccount(): Promise<AccountDto> {
  return apiFetch('/v1/account');
}

/** Sets it. First-party only server-side — no connected AI can call this. */
export function setFirstName(firstName: string): Promise<{ firstName: string }> {
  return apiFetch('/v1/account/name', {
    method: 'PATCH',
    body: JSON.stringify({ firstName }),
  });
}
