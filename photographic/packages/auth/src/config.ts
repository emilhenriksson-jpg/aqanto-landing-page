/**
 * Authorization server configuration.
 *
 * Only `issuer` and `resource` are required; every endpoint defaults to a path under the
 * issuer so that the metadata document and the mounted routes cannot drift apart.
 */

import { SUPPORTED_SCOPES } from './scopes.js';

export interface AuthServerConfigInput {
  /** Origin of the authorization server, no trailing slash: `https://api.photographic.se`. */
  issuer: string;
  /**
   * Canonical identifier of the protected resource (RFC 8707 / RFC 9728). For us this is
   * the MCP endpoint, because that is what ChatGPT and Claude are actually connecting to.
   */
  resource: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  /** Browser page that logs a person in and returns them to `/oauth/authorize`. */
  loginUrl?: string;
  /** Consent page. When set, `authorize` sends the person here before issuing a code. */
  consentUrl?: string;
  documentationUrl?: string;
  serviceDocumentation?: string;
  scopesSupported?: string[];
  /** Short by design: a code lives only as long as a redirect takes. */
  authorizationCodeTtlSeconds?: number;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  /** DCR guard rails. */
  maxRedirectUris?: number;
  maxClientNameLength?: number;
}

export interface AuthServerConfig {
  issuer: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string;
  loginUrl: string;
  consentUrl: string | null;
  documentationUrl: string | null;
  serviceDocumentation: string | null;
  scopesSupported: string[];
  authorizationCodeTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  maxRedirectUris: number;
  maxClientNameLength: number;
}

export const DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS = 60;
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
/** Long-lived on purpose: an MCP connector the person set up months ago must still work. */
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 60;
export const DEFAULT_MAX_REDIRECT_URIS = 5;
export const DEFAULT_MAX_CLIENT_NAME_LENGTH = 120;

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function resolveAuthConfig(input: AuthServerConfigInput): AuthServerConfig {
  const issuer = trimTrailingSlash(input.issuer);
  return {
    issuer,
    resource: trimTrailingSlash(input.resource),
    authorizationEndpoint: input.authorizationEndpoint ?? `${issuer}/oauth/authorize`,
    tokenEndpoint: input.tokenEndpoint ?? `${issuer}/oauth/token`,
    registrationEndpoint: input.registrationEndpoint ?? `${issuer}/oauth/register`,
    revocationEndpoint: input.revocationEndpoint ?? `${issuer}/oauth/revoke`,
    loginUrl: input.loginUrl ?? `${issuer}/login`,
    consentUrl: input.consentUrl ?? null,
    documentationUrl: input.documentationUrl ?? null,
    serviceDocumentation: input.serviceDocumentation ?? null,
    scopesSupported: input.scopesSupported ?? [...SUPPORTED_SCOPES],
    authorizationCodeTtlSeconds:
      input.authorizationCodeTtlSeconds ?? DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS,
    accessTokenTtlSeconds: input.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: input.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    maxRedirectUris: input.maxRedirectUris ?? DEFAULT_MAX_REDIRECT_URIS,
    maxClientNameLength: input.maxClientNameLength ?? DEFAULT_MAX_CLIENT_NAME_LENGTH,
  };
}
