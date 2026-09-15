/**
 * Clients: registration, authentication, and redirect URI validation.
 *
 * Dynamic client registration is open — no credential required to call it — because it
 * has to be. An MCP client discovers this server from a 401, registers itself, and runs
 * the flow without a person ever seeing a developer console. Closing it would mean every
 * new client needs us to issue it credentials by hand, which is the friction the whole
 * connect story exists to remove.
 *
 * Open registration means the validation here is the only thing between us and a
 * redirect URI that sends authorization codes to an attacker. So:
 *
 *   - Redirect URIs are matched exactly at authorize time. Not by prefix, not by origin,
 *     not ignoring the query. Every published attack on this is a matcher that was
 *     cleverer than a string comparison.
 *   - Plain `http` is refused except on loopback, where there is no network to intercept.
 *   - A registration is a claim, not an identity. `client_name` is attacker-controlled
 *     text that a person will read on a consent screen, so it is length-capped and
 *     rendered as data, never trusted.
 */

import { ValidationError } from '@photographic/core';

import type { AuthServerConfig } from './config.js';
import { constantTimeEqual, randomToken } from './crypto.js';
import type {
  Clock,
  NewOAuthClient,
  OAuthClientRecord,
  OAuthClientStore,
  TokenEndpointAuthMethod,
} from './deps.js';
import { deriveClientIdentity } from './identity.js';
import { hashSecret } from './tokens.js';
import { formatScope, parseScope, SUPPORTED_SCOPES } from './scopes.js';

export const CLIENT_ID_PREFIX = 'pgm_client_';
export const CLIENT_SECRET_PREFIX = 'pgm_cs_';

const ALLOWED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
const ALLOWED_AUTH_METHODS: TokenEndpointAuthMethod[] = [
  'none',
  'client_secret_basic',
  'client_secret_post',
];

/**
 * Schemes that are never a redirect target, whatever a client claims.
 *
 * `javascript:` and `data:` are code execution in whatever browser follows the redirect.
 * `file:` and `blob:` read local state. `about:` and `view-source:` are browser surfaces.
 * None of them can receive an authorization code in any useful sense, so a registration
 * naming one is either broken or an attempt to turn our redirect into an XSS sink.
 */
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'view-source:',
  'ws:',
  'wss:',
  'ftp:',
]);

/**
 * Whether a redirect URI is safe to send an authorization code to.
 *
 * Three families, with different reasoning each.
 *
 * `https` anywhere: the transport protects the code in flight.
 *
 * `http` on loopback only: a native app cannot hold a secret and cannot serve https, so
 * it listens on 127.0.0.1, and this is the documented answer (RFC 8252). The port is
 * deliberately not pinned — the app takes whatever the OS gives it — which is why
 * loopback is the one place exact matching is relaxed, and only for the port.
 *
 * Private-use schemes: `cursor://`, `vscode://`, `claude://`. This is how a desktop
 * client gets the redirect back from the system browser, and refusing them would mean
 * refusing most of the clients this product exists to serve. RFC 8252 recommends a
 * reverse-DNS scheme, and no shipping client follows that, so the rule here is a denylist
 * of schemes that cannot receive a code rather than a pattern real clients fail.
 *
 * The protection for private-use schemes is not the scheme check — the OS decides which
 * app owns `cursor://` and we cannot see that. It is PKCE: a code delivered to the wrong
 * app is useless without the verifier that app never had.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  // A fragment is never sent to the server and cannot be matched, so a client that
  // registers one either misunderstands the protocol or is probing the matcher.
  if (url.hash !== '') return false;

  if (url.protocol === 'https:') return url.hostname !== '';

  if (url.protocol === 'http:') {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  }

  if (FORBIDDEN_SCHEMES.has(url.protocol)) return false;
  if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return false;

  // Something has to follow the scheme. `cursor:` alone is not a destination, and a bare
  // scheme is what a probe for a lenient matcher looks like.
  return url.pathname !== '' || url.host !== '';
}

/**
 * Exact match, with one carve-out.
 *
 * Loopback redirects ignore the port, because a native app binds an ephemeral one and
 * cannot know it at registration time (RFC 8252 section 7.3). Everything else — scheme,
 * host, path, query — has to be identical, and the carve-out is scoped to loopback so
 * there is nowhere else for it to be exploited.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (constantTimeEqual(registered, presented)) return true;

  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(presented);
  } catch {
    return false;
  }

  const loopback = (host: string) =>
    host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

  if (a.protocol !== 'http:' || b.protocol !== 'http:') return false;
  if (!loopback(a.hostname) || !loopback(b.hostname)) return false;

  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

export interface RegistrationRequest {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
  scope?: unknown;
  [key: string]: unknown;
}

export interface RegistrationResult {
  record: OAuthClientRecord;
  /** Returned to the client exactly once. Null for public clients. */
  clientSecret: string | null;
  scope: string;
}

/**
 * RFC 7591 registration.
 *
 * Public clients (`token_endpoint_auth_method: none`) are the common case and the
 * default: every MCP client that runs on a person's machine is one, and issuing it a
 * secret would only mean shipping a secret inside software the person can read. Their
 * security comes from PKCE, which this server requires unconditionally.
 */
export async function registerClient(
  input: RegistrationRequest,
  deps: { clients: OAuthClientStore; config: AuthServerConfig; now?: Clock },
): Promise<RegistrationResult> {
  const redirectUris = asStringArray(input.redirect_uris);
  if (redirectUris.length === 0) {
    throw new ValidationError('redirect_uris is required and must be a non-empty array');
  }
  if (redirectUris.length > deps.config.maxRedirectUris) {
    throw new ValidationError(`at most ${deps.config.maxRedirectUris} redirect_uris`);
  }
  for (const uri of redirectUris) {
    if (!isAllowedRedirectUri(uri)) {
      throw new ValidationError(`redirect_uri not allowed: ${uri}`);
    }
  }

  const grantTypes = asStringArray(input.grant_types);
  const grants = grantTypes.length === 0 ? ['authorization_code', 'refresh_token'] : grantTypes;
  for (const grant of grants) {
    if (!ALLOWED_GRANT_TYPES.includes(grant as (typeof ALLOWED_GRANT_TYPES)[number])) {
      throw new ValidationError(`unsupported grant_type: ${grant}`);
    }
  }

  const responseTypes = asStringArray(input.response_types);
  for (const type of responseTypes) {
    // No implicit grant, no hybrid. OAuth 2.1 removed them, and they hand a token to a
    // browser redirect where it lands in history and referrers.
    if (type !== 'code') throw new ValidationError(`unsupported response_type: ${type}`);
  }

  const authMethod = (input.token_endpoint_auth_method ?? 'none') as TokenEndpointAuthMethod;
  if (!ALLOWED_AUTH_METHODS.includes(authMethod)) {
    throw new ValidationError(`unsupported token_endpoint_auth_method: ${String(authMethod)}`);
  }

  const requestedScope = typeof input.scope === 'string' ? input.scope : undefined;
  const scopes = parseScope(requestedScope).filter((scope) => SUPPORTED_SCOPES.includes(scope));

  const clientName = clientNameOf(input.client_name, deps.config.maxClientNameLength);
  const clientSecret = authMethod === 'none' ? null : CLIENT_SECRET_PREFIX + randomToken(32);

  // Derived here and only here. The store freezes it, so this is the single moment at
  // which an attacker-controlled registration name is allowed to influence what the
  // person's own history calls this client.
  const identity = deriveClientIdentity(clientName);

  const client: NewOAuthClient = {
    clientId: CLIENT_ID_PREFIX + randomToken(16),
    clientSecretHash: clientSecret === null ? null : hashSecret(clientSecret),
    clientName,
    redirectUris,
    grantTypes: grants,
    tokenEndpointAuth: authMethod,
    registeredVia: 'dcr',
    cimdUrl: null,
    agentClient: identity.agentClient,
    clientLabel: identity.clientLabel,
    labelSource: identity.labelSource,
  };

  return {
    record: await deps.clients.create(client),
    clientSecret,
    scope: formatScope(scopes),
  };
}

/** The registration response, in RFC 7591's field names. */
export function registrationResponse(result: RegistrationResult): Record<string, unknown> {
  const { record } = result;

  return {
    client_id: record.clientId,
    ...(result.clientSecret === null ? {} : { client_secret: result.clientSecret }),
    client_id_issued_at: Math.floor(record.createdAt.getTime() / 1000),
    client_name: record.clientName,
    redirect_uris: record.redirectUris,
    grant_types: record.grantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: record.tokenEndpointAuth,
    ...(result.scope === '' ? {} : { scope: result.scope }),
  };
}

export type ClientAuthResult =
  | { ok: true; client: OAuthClientRecord }
  | { ok: false; error: 'invalid_client'; reason: string };

/**
 * Authenticates a client at the token endpoint.
 *
 * A public client authenticates by naming itself, which is not authentication at all —
 * and is fine, because the code it is redeeming is bound to a PKCE verifier only the
 * instance that started the flow knows. That binding is what replaces the secret, so the
 * one thing this function must never do is accept a `client_id` with no secret for a
 * client that registered with one.
 */
export async function authenticateClient(
  presented: { clientId: string | null; clientSecret: string | null },
  clients: OAuthClientStore,
): Promise<ClientAuthResult> {
  if (!presented.clientId) {
    return { ok: false, error: 'invalid_client', reason: 'client_id is required' };
  }

  const client = await clients.findByClientId(presented.clientId);
  if (!client) {
    return { ok: false, error: 'invalid_client', reason: 'unknown client' };
  }

  if (client.tokenEndpointAuth === 'none') {
    if (presented.clientSecret) {
      return { ok: false, error: 'invalid_client', reason: 'client is public' };
    }
    return { ok: true, client };
  }

  if (!client.clientSecretHash || !presented.clientSecret) {
    return { ok: false, error: 'invalid_client', reason: 'client_secret is required' };
  }
  if (!constantTimeEqual(hashSecret(presented.clientSecret), client.clientSecretHash)) {
    return { ok: false, error: 'invalid_client', reason: 'bad client_secret' };
  }

  return { ok: true, client };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item !== '' && !out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * A name a person will read on a consent screen.
 *
 * Attacker-controlled: anyone can register a client called "Photographic Official". It is
 * length-capped and stripped of control characters and line breaks here, so it cannot
 * forge layout wherever it is displayed, and the consent page is responsible for the rest.
 */
function clientNameOf(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return 'Okänd klient';

  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();

  return cleaned === '' ? 'Okänd klient' : cleaned.slice(0, maxLength);
}
