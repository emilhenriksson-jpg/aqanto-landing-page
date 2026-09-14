/**
 * The contract this app expects from `@photographic/auth`.
 *
 * The auth package does not exist yet, so the shape lives here: framework-agnostic in,
 * framework-agnostic out, so that mounting the real implementation later is a one-line
 * change in `oauth.ts` and nothing in this file has to move.
 *
 * Everything here is transport plumbing. The only part the rest of the API cares about
 * is `introspect`, which turns a bearer token into claims; `middleware/auth.ts` turns
 * those claims into an `Actor`.
 */

import type { AgentClient, PersonId, RoomId, SessionId } from '@photographic/core';

/** A request reduced to the parts an OAuth handler needs. */
export interface OAuthRequest {
  method: string;
  /** Absolute URL as the client called it, including query string. */
  url: string;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  /** Decoded `application/x-www-form-urlencoded` or JSON body; `{}` for GET. */
  body: Record<string, unknown>;
  /** Best-effort peer address, for rate limiting and audit inside the auth package. */
  clientAddress: string | null;
}

export interface OAuthResponse {
  status: number;
  headers?: Record<string, string>;
  /** Serialised as JSON when it is an object, sent verbatim when it is a string. */
  body?: unknown;
}

/**
 * What a valid access token proves. Note what is absent: no room ids from the request,
 * no client-asserted identity. Claims come from the token and nowhere else.
 */
export interface TokenClaims {
  personId: PersonId;
  sessionId: SessionId | null;
  /** Which surface the token was issued to, when the authorisation server knows. */
  agentClient: AgentClient | null;
  clientId: string | null;
  scopes: string[];
  /** Empty means every room the person belongs to. Non-empty narrows the token. */
  roomScope: RoomId[];
  expiresAt: Date | null;
}

/** RFC 8414, trimmed to the fields MCP clients actually read. */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  jwks_uri?: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  service_documentation?: string;
}

/** RFC 9728. MCP clients fetch this to discover which authorisation server to use. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
}

export interface MetadataInput {
  /** The externally reachable origin of this API, without a trailing slash. */
  publicUrl: string;
  issuer: string;
}

/**
 * OAuth 2.1 with PKCE and dynamic client registration.
 *
 * `authorize`, `token`, `register` and `revoke` receive a reduced request and return a
 * reduced response, so the auth package never imports hono and this app never imports
 * a web framework's types into its domain.
 */
export interface OAuthProvider {
  /** Resolves a bearer token to claims, or null when it is unknown or expired. */
  introspect(token: string): Promise<TokenClaims | null>;

  authorize(request: OAuthRequest): Promise<OAuthResponse>;
  token(request: OAuthRequest): Promise<OAuthResponse>;
  /** RFC 7591 dynamic client registration; MCP clients rely on it. */
  register(request: OAuthRequest): Promise<OAuthResponse>;
  revoke(request: OAuthRequest): Promise<OAuthResponse>;

  /** Optional: served at `/.well-known/jwks.json` when present. */
  jwks?(request: OAuthRequest): Promise<OAuthResponse>;

  /** Optional overrides; the defaults in `oauth.ts` are derived from config. */
  authorizationServerMetadata?(input: MetadataInput): AuthorizationServerMetadata;
  protectedResourceMetadata?(input: MetadataInput): ProtectedResourceMetadata;
}

export const OAUTH_SCOPES = [
  'memory.read',
  'memory.write',
  'rooms.read',
  'rooms.write',
  'documents.write',
] as const;

export const OAUTH_PATHS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
  revoke: '/oauth/revoke',
  jwks: '/.well-known/jwks.json',
  authorizationServerMetadata: '/.well-known/oauth-authorization-server',
  protectedResourceMetadata: '/.well-known/oauth-protected-resource',
} as const;

export function defaultAuthorizationServerMetadata(
  input: MetadataInput,
): AuthorizationServerMetadata {
  const base = input.publicUrl.replace(/\/+$/, '');
  return {
    issuer: input.issuer,
    authorization_endpoint: `${base}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${base}${OAUTH_PATHS.token}`,
    registration_endpoint: `${base}${OAUTH_PATHS.register}`,
    revocation_endpoint: `${base}${OAUTH_PATHS.revoke}`,
    jwks_uri: `${base}${OAUTH_PATHS.jwks}`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  };
}

export function defaultProtectedResourceMetadata(input: MetadataInput): ProtectedResourceMetadata {
  const base = input.publicUrl.replace(/\/+$/, '');
  return {
    resource: base,
    authorization_servers: [input.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

/**
 * Stands in for `@photographic/auth` until it lands. It answers the metadata
 * documents (those are pure config) and refuses every flow with 501, so a
 * half-wired deployment fails loudly instead of authenticating someone by accident.
 */
export function createStubOAuthProvider(): OAuthProvider {
  const notImplemented = async (): Promise<OAuthResponse> => ({
    status: 501,
    body: {
      error: 'temporarily_unavailable',
      error_description: 'OAuth-servern är inte inkopplad ännu.',
    },
  });

  return {
    introspect: async () => null,
    authorize: notImplemented,
    token: notImplemented,
    register: notImplemented,
    revoke: notImplemented,
  };
}
