/**
 * The two discovery documents, which are what make one-click connection possible.
 *
 * A client that gets a 401 from the MCP endpoint reads `WWW-Authenticate`, fetches the
 * protected resource metadata, finds the authorization server, fetches its metadata,
 * registers itself, and runs the flow. Nobody types anything. Every field below is read
 * by at least one shipping client, and a missing `registration_endpoint` is the
 * difference between that and a support conversation.
 */

import type { AuthServerConfig } from './config.js';

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
  service_documentation?: string;
}

export function authorizationServerMetadata(
  config: AuthServerConfig,
): AuthorizationServerMetadata {
  return {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    registration_endpoint: config.registrationEndpoint,
    revocation_endpoint: config.revocationEndpoint,
    scopes_supported: [...config.scopesSupported],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only, advertised as such. A server that also lists `plain` invites a client to
    // use it, and the downgrade is the attack PKCE exists to stop.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: [
      'none',
      'client_secret_basic',
      'client_secret_post',
    ],
    ...(config.serviceDocumentation ? { service_documentation: config.serviceDocumentation } : {}),
  };
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
}

export function protectedResourceMetadata(config: AuthServerConfig): ProtectedResourceMetadata {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...config.scopesSupported],
    bearer_methods_supported: ['header'],
    ...(config.documentationUrl ? { resource_documentation: config.documentationUrl } : {}),
  };
}
