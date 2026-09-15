/**
 * The contract this app expects from `@photographic/auth`.
 *
 * Framework-agnostic in, framework-agnostic out: the auth package never imports hono and
 * `oauth.ts` adapts one to the other, so a framework upgrade cannot reach the
 * security-critical code.
 *
 * Everything here is transport plumbing. The only part the rest of the API cares about
 * is `introspect`, which turns a bearer token into claims; `middleware.ts` turns
 * those claims into an `Actor`.
 */

import { SUPPORTED_SCOPES } from '@photographic/auth';
import type { AgentClient, PersonId, RoomId, SessionId } from '@photographic/core';

/**
 * The `clientId` on claims resolved from a browser session rather than an access token.
 *
 * The web and onboarding apps sign a person in with a code sent to their email and never
 * run an OAuth flow, so there is no registered client to name. Naming it explicitly is
 * what lets a route say "the person's own browser, not one of their AIs" — which is the
 * right rule for managing the AIs themselves.
 */
export const FIRST_PARTY_CLIENT_ID = 'first-party';

/** A request reduced to the parts an OAuth handler needs. */
export interface OAuthRequest {
  method: string;
  /** Absolute URL as the client called it, including query string. */
  url: string;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  /**
   * The body, either raw or already decoded.
   *
   * Raw is the normal case: which of form-encoding and JSON a body is depends on the
   * endpoint, and the handler knows that where the transport does not. A pre-decoded
   * object is accepted so a test can construct a request without serialising one.
   */
  body: Record<string, unknown> | string;
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

  /**
   * The two halves of the login split, which are not in any RFC.
   *
   * Photographic has no passwords, so `authorize` cannot read an identity off the
   * request: it parks the validated request and sends the browser to a login page. That
   * page asks `describeRequest` what it is about to approve, and calls `approve` with the
   * person's session token once they have answered. Optional because a deployment can
   * omit them and lose only the browser half of the flow.
   */
  describeRequest?(request: OAuthRequest): Promise<OAuthResponse>;
  approve?(request: OAuthRequest): Promise<OAuthResponse>;

  /** Optional: served at `/.well-known/jwks.json` when present. */
  jwks?(request: OAuthRequest): Promise<OAuthResponse>;

  /** Optional overrides; the defaults in `oauth.ts` are derived from config. */
  authorizationServerMetadata?(input: MetadataInput): AuthorizationServerMetadata;
  protectedResourceMetadata?(input: MetadataInput): ProtectedResourceMetadata;
}

/**
 * The scope vocabulary, from the package that enforces it.
 *
 * Re-exported rather than restated. `validateScope` refuses a scope it does not
 * recognise at authorization time, so a list here that named a scope it has never heard
 * of would advertise a capability no client can actually be granted.
 */
export const OAUTH_SCOPES: readonly string[] = SUPPORTED_SCOPES;

export const OAUTH_PATHS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
  revoke: '/oauth/revoke',
  /** Read and written by the login page, not by an AI client. */
  authorizeRequest: '/oauth/authorize/request',
  authorizeApprove: '/oauth/authorize/approve',
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
