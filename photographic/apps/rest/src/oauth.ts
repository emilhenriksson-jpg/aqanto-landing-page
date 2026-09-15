/**
 * Mounting `@photographic/auth`.
 *
 * Two translations and nothing else: `AuthRequest`/`AuthResponse` become
 * `OAuthRequest`/`OAuthResponse`. The reason this is separate from the contract it
 * satisfies is that the contract is what `app.ts` and its tests depend on, and they
 * should not have to load an authorization server to talk to a fake one.
 */

import type { AuthRequest, AuthResponse, AuthServer } from '@photographic/auth';
import { authorizationServerMetadata, protectedResourceMetadata } from '@photographic/auth';

import type {
  AuthorizationServerMetadata,
  OAuthProvider,
  OAuthRequest,
  OAuthResponse,
  ProtectedResourceMetadata,
} from './oauth-contract.js';

export function createOAuthProvider(auth: AuthServer): OAuthProvider {
  const call =
    (handler: (request: AuthRequest) => Promise<AuthResponse>) =>
    async (request: OAuthRequest): Promise<OAuthResponse> =>
      fromAuthResponse(await handler(toAuthRequest(request)));

  return {
    introspect: (token) => auth.introspect(token),

    authorize: call((request) => auth.authorize(request)),
    token: call((request) => auth.token(request)),
    register: call((request) => auth.register(request)),
    revoke: call((request) => auth.revoke(request)),
    describeRequest: call((request) => auth.describeRequest(request)),
    approve: call((request) => auth.approve(request)),

    // Returned as objects rather than the server's own JSON responses, because `app.ts`
    // serves these two and the contract's defaults have to stay replaceable.
    authorizationServerMetadata: (): AuthorizationServerMetadata =>
      authorizationServerMetadata(auth.config),
    protectedResourceMetadata: (): ProtectedResourceMetadata =>
      protectedResourceMetadata(auth.config),
  };
}

function toAuthRequest(request: OAuthRequest): AuthRequest {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body,
    ip: request.clientAddress ?? undefined,
  };
}

/**
 * The auth package has already serialised its body and set its own headers, including
 * `cache-control: no-store` on everything carrying a credential. Passing the string
 * through unparsed is what keeps that true — re-serialising here would be a second place
 * where the wire format of a token response gets decided.
 */
function fromAuthResponse(response: AuthResponse): OAuthResponse {
  return { status: response.status, headers: response.headers, body: response.body };
}
