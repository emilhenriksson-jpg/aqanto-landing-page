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
  /**
   * Always `sms`. The union is the wire shape, not an offer: the domain still knows how
   * to send by email and the endpoint no longer accepts an address for one.
   */
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

/** What an AI client is asking for, as the person needs to see it. */
export interface AuthorizationRequest {
  requestId: string;
  /**
   * The name the client registered under. Registration is open, so anyone can call
   * themselves anything: this is text to display, never a claim to trust.
   */
  clientName: string;
  scopes: string[];
  expiresAt: string;
}

export interface Api {
  /** `phone` is E.164 by the time it gets here; the screen normalises what was typed. */
  requestCode(input: { phone: string; inviteToken?: string }): Promise<RequestCodeResponse>;
  verifyCode(input: { requestId: string; code: string }): Promise<VerifyCodeResponse>;
  connect(): Promise<ConnectPayload>;
  peekInvite(token: string): Promise<InvitePreview>;
  startVerification(clientId: ClientId): Promise<{ handle: VerificationHandle; prompt: string }>;
  verificationStatus(handle: VerificationHandle): Promise<VerificationState>;
  health(): Promise<ClientHealthEntry[]>;
  renderedProfile(): Promise<string>;

  /**
   * Sets the person's own first name, right after they sign in for the first time (or
   * later, from the account screen — outside this app). Same endpoint either way.
   */
  setFirstName(firstName: string): Promise<{ firstName: string }>;

  /** What a parked authorization request is for, so the person can decide. */
  describeAuthorization(requestId: string): Promise<AuthorizationRequest>;
  /** Answers it. Returns where to send the browser, back to the client that asked. */
  answerAuthorization(input: {
    requestId: string;
    approved: boolean;
  }): Promise<{ redirectUrl: string; approved: boolean }>;

  /** Remembers who is signed in, for the calls that need it. */
  setSession(token: string | null): void;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * The session token, in memory only.
 *
 * Not `localStorage`: it is a bearer credential for someone's entire memory, and anything
 * that can run script on the page can read it there. Keeping it in a closure means a
 * reload signs the person in again, which is a second of friction against a class of
 * theft that survives closing the tab.
 */
let sessionToken: string | null = null;

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const body = (await response.json().catch(() => null)) as
    | { message?: string; error_description?: string; error?: { message?: string } }
    | null;

  if (!response.ok) {
    // The API answers with `error.message`; the OAuth endpoints answer with
    // `error_description`, because that is what the RFC says. Both end up in front of a
    // person, so both are read here rather than in each caller.
    const message =
      body?.error?.message ?? body?.error_description ?? body?.message ?? 'Något gick fel.';
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export const httpApi: Api = {
  setSession: (token) => {
    sessionToken = token;
  },
  requestCode: (input) => send('/v1/signup/request', { method: 'POST', body: JSON.stringify(input) }),
  verifyCode: (input) => send('/v1/signup/verify', { method: 'POST', body: JSON.stringify(input) }),
  connect: () => send('/v1/connect'),
  peekInvite: (token) => send(`/v1/invites/${encodeURIComponent(token)}`),
  startVerification: (clientId) =>
    send('/v1/connect/verify', { method: 'POST', body: JSON.stringify({ clientId }) }),
  verificationStatus: (handle) =>
    send('/v1/connect/status', { method: 'POST', body: JSON.stringify({ handle }) }),
  health: async () => {
    const body = await send<{ clients: ClientHealthEntry[] }>('/v1/clients');
    return body.clients;
  },
  renderedProfile: async () => {
    const body = await send<{ profile: { rendered: string } }>('/v1/profile');
    return body.profile.rendered;
  },
  setFirstName: (firstName) =>
    send('/v1/account/name', { method: 'PATCH', body: JSON.stringify({ firstName }) }),
  describeAuthorization: (requestId) =>
    send(`/oauth/authorize/request?auth_request=${encodeURIComponent(requestId)}`),
  answerAuthorization: (input) =>
    send('/oauth/authorize/approve', { method: 'POST', body: JSON.stringify(input) }),
};
