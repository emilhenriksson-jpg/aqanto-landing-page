/**
 * The API surface these screens need, behind an interface so components can be tested
 * without a server. Types come from `@photographic/connect` rather than being restated,
 * so a change to a descriptor breaks this build instead of drifting silently.
 */

import type {
  ClientDescriptor,
  ClientId,
  ConnectPayload,
  VerificationHandle,
  VerificationState,
} from '@photographic/connect';

export type { ClientDescriptor, ClientId, ConnectPayload, VerificationHandle, VerificationState };

export interface RequestCodeResponse {
  requestId: string;
  channel: 'email' | 'sms';
  destinationHint: string;
  expiresAt: string;
}

export interface VerifyCodeResponse {
  session: { token: string; expiresAt: string };
  created: boolean;
  person: { id: string; displayName: string | null };
  personalRoom: { id: string; title: string };
  joinedRoom: { id: string; title: string; role: string } | null;
  next: 'connect';
}

export interface InvitePreview {
  room: { id: string; title: string; description: string | null };
  invitedByName: string | null;
  preview: string | null;
}

export interface ClientHealthEntry {
  agentClient: string;
  displayName: string;
  lastSeenAt: string;
  profileDelivered: boolean;
  deliveryMethod: string | null;
  degraded: boolean;
}

export interface Api {
  requestCode(input: { email?: string; phone?: string; inviteToken?: string }): Promise<RequestCodeResponse>;
  verifyCode(input: { requestId: string; code: string }): Promise<VerifyCodeResponse>;
  connect(): Promise<ConnectPayload>;
  peekInvite(token: string): Promise<InvitePreview>;
  startVerification(clientId: ClientId): Promise<{ handle: VerificationHandle; prompt: string }>;
  verificationStatus(handle: VerificationHandle): Promise<VerificationState>;
  health(): Promise<ClientHealthEntry[]>;
  renderedProfile(): Promise<string>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'include',
  });

  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  if (!response.ok) {
    throw new ApiError(body?.message ?? 'Något gick fel.', response.status);
  }
  return body as T;
}

export const httpApi: Api = {
  requestCode: (input) => send('/v1/signup/request', { method: 'POST', body: JSON.stringify(input) }),
  verifyCode: (input) => send('/v1/signup/verify', { method: 'POST', body: JSON.stringify(input) }),
  connect: () => send('/v1/connect'),
  peekInvite: (token) => send(`/v1/invites/${encodeURIComponent(token)}`),
  startVerification: (clientId) =>
    send('/v1/connect/verify', { method: 'POST', body: JSON.stringify({ clientId }) }),
  verificationStatus: (handle) =>
    send('/v1/connect/status', { method: 'POST', body: JSON.stringify({ handle }) }),
  health: () => send('/v1/me/clients'),
  renderedProfile: async () => {
    const body = await send<{ rendered: string }>('/v1/context/rendered');
    return body.rendered;
  },
};
