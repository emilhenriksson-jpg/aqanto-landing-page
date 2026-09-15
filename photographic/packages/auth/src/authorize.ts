/**
 * The authorization endpoint, in two halves.
 *
 * It is two halves because Photographic has no passwords and no session cookie. A person
 * proves who they are with a code sent to their email or phone, and the sign-up flow
 * hands the browser a session token it keeps itself. So there is no identity to read off
 * a `GET /oauth/authorize`, and the flow becomes:
 *
 *   1. `start`   validates the request completely, parks it under an opaque id, and
 *                redirects the browser to the login page with that id.
 *   2. `approve` is called by that page once the person is signed in, with their session
 *                token, and mints the authorization code.
 *
 * Validating everything in step 1 is the part that matters. The redirect URI and the PKCE
 * challenge are fixed before the person sees a login screen, so nothing that happens
 * afterwards — on the login page, in the person's browser, in a second tab — can change
 * where the code is sent.
 *
 * Which errors go where is also load-bearing, and gets this wrong in a lot of
 * implementations. An invalid `client_id` or `redirect_uri` must be shown to the person,
 * never redirected: redirecting is how an attacker gets us to deliver an error, and a
 * code, to a URI we just decided we do not trust. Everything after those two is
 * redirected with `error` and `state`, which is what the client is waiting for.
 */

import type { PersonId } from '@photographic/core';

import type { AuthServerConfig } from './config.js';
import { isValidCodeChallenge, randomToken } from './crypto.js';
import type {
  AuthCodeStore,
  AuthLogger,
  Clock,
  OAuthClientStore,
  PendingAuthorizationStore,
  PersonLookup,
  SessionTokenVerifier,
} from './deps.js';
import { silentLogger } from './deps.js';
import { redirectUriMatches } from './clients.js';
import { validateScope } from './scopes.js';
import { hashSecret, newAuthorizationCode } from './tokens.js';

/** Long enough for a person to fetch an email and paste a code, and no longer. */
export const PENDING_AUTHORIZATION_TTL_SECONDS = 15 * 60;

export interface AuthorizeDeps {
  clients: OAuthClientStore;
  pending: PendingAuthorizationStore;
  codes: AuthCodeStore;
  sessions: SessionTokenVerifier;
  people: PersonLookup;
  config: AuthServerConfig;
  now?: Clock;
  logger?: AuthLogger;
}

/**
 * What to do with the browser.
 *
 * `show` is an error the person has to read, because we have decided the redirect URI is
 * not one we will send anything to. `redirect` is everything else.
 */
export type AuthorizeStart =
  | { kind: 'redirect'; url: string }
  | { kind: 'show'; error: string; description: string };

export interface AuthorizeParams {
  response_type?: string | undefined;
  client_id?: string | undefined;
  redirect_uri?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
  scope?: string | undefined;
  state?: string | undefined;
  resource?: string | undefined;
}

export async function startAuthorization(
  params: AuthorizeParams,
  deps: AuthorizeDeps,
): Promise<AuthorizeStart> {
  const log = deps.logger ?? silentLogger;
  const now = (deps.now ?? (() => new Date()))();

  // --- Errors the person sees, because we will not redirect ----------------------

  if (!params.client_id) {
    return show('invalid_request', 'client_id saknas.');
  }

  const client = await deps.clients.findByClientId(params.client_id);
  if (!client) {
    log.warn('oauth.authorize.unknown_client', { clientId: params.client_id });
    return show('invalid_client', 'Den klienten är inte registrerad.');
  }

  if (!params.redirect_uri) {
    return show('invalid_request', 'redirect_uri saknas.');
  }

  const registered = client.redirectUris.find((uri) =>
    redirectUriMatches(uri, params.redirect_uri as string),
  );
  if (!registered) {
    log.warn('oauth.authorize.redirect_mismatch', {
      clientId: client.clientId,
      presented: params.redirect_uri,
    });
    return show(
      'invalid_request',
      'redirect_uri matchar inte den som klienten registrerade. Anslutningen avbröts.',
    );
  }

  // --- Errors the client sees, redirected -----------------------------------------

  const redirectError = (error: string, description: string): AuthorizeStart => ({
    kind: 'redirect',
    url: errorRedirect(params.redirect_uri as string, error, description, params.state),
  });

  if (params.response_type !== 'code') {
    return redirectError('unsupported_response_type', 'Endast response_type=code stöds.');
  }

  // PKCE is required of every client, public or confidential, with no downgrade path.
  // `plain` is not accepted: allowing it means an attacker who intercepts the redirect can
  // supply the challenge as the verifier, which is the whole attack PKCE prevents.
  if (!params.code_challenge) {
    return redirectError('invalid_request', 'code_challenge krävs.');
  }
  if ((params.code_challenge_method ?? 'plain') !== 'S256') {
    return redirectError('invalid_request', 'code_challenge_method måste vara S256.');
  }
  if (!isValidCodeChallenge(params.code_challenge)) {
    return redirectError('invalid_request', 'code_challenge har fel format.');
  }

  const scope = validateScope(params.scope);
  if (!scope.ok) {
    return redirectError('invalid_scope', scope.reason);
  }

  // RFC 8707. A client that names a resource must name ours; a client that names none is
  // accepted, because most MCP clients still do not send it.
  if (params.resource && trimSlash(params.resource) !== deps.config.resource) {
    return redirectError('invalid_target', 'resource matchar inte den här servern.');
  }

  const record = await deps.pending.create({
    id: randomToken(24),
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    scope: scope.scope,
    state: params.state ?? null,
    resource: params.resource ? trimSlash(params.resource) : null,
    expiresAt: new Date(now.getTime() + PENDING_AUTHORIZATION_TTL_SECONDS * 1000),
  });

  log.info('oauth.authorize.started', {
    clientId: client.clientId,
    requestId: record.id,
    scope: scope.scope,
  });

  const login = new URL(deps.config.loginUrl);
  login.searchParams.set('auth_request', record.id);

  return { kind: 'redirect', url: login.toString() };
}

/**
 * What the login page shows the person before they approve.
 *
 * Deliberately thin. The person is deciding whether to give a named piece of software
 * access to their memory, and the only facts that help them are which software, and what
 * it will be able to do. `clientName` came from an open registration endpoint and is
 * attacker-controlled, so it is data to display, never a claim to trust.
 */
export interface PendingAuthorizationView {
  requestId: string;
  clientName: string;
  scopes: string[];
  expiresAt: Date;
}

export async function describeAuthorization(
  requestId: string,
  deps: Pick<AuthorizeDeps, 'pending' | 'now'>,
): Promise<PendingAuthorizationView | null> {
  const now = (deps.now ?? (() => new Date()))();
  const record = await deps.pending.find(requestId);

  if (!record) return null;
  if (record.consumedAt !== null) return null;
  if (record.expiresAt.getTime() <= now.getTime()) return null;

  return {
    requestId: record.id,
    clientName: record.clientName,
    scopes: record.scope.split(' ').filter((scope) => scope !== ''),
    expiresAt: record.expiresAt,
  };
}

export type ApproveResult =
  | { ok: true; redirectUrl: string; personId: PersonId; clientId: string }
  | { ok: false; error: string; description: string };

/**
 * Mints the authorization code, once the person is signed in and has said yes.
 *
 * The session token is the person's proof of identity and is checked here rather than
 * taken from the request body, because the alternative — trusting a `person_id` the login
 * page sends — would make the authorization endpoint hand out codes for anyone whose id
 * an attacker could guess.
 *
 * A declined request is consumed too. Leaving it open would let a page that has already
 * shown the person a refusal come back and approve it.
 */
export async function approveAuthorization(
  input: { requestId: string; sessionToken: string; approved?: boolean },
  deps: AuthorizeDeps,
): Promise<ApproveResult> {
  const log = deps.logger ?? silentLogger;
  const now = (deps.now ?? (() => new Date()))();

  const record = await deps.pending.find(input.requestId);
  if (!record || record.consumedAt !== null) {
    return { ok: false, error: 'invalid_request', description: 'Förfrågan finns inte längre.' };
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      error: 'invalid_request',
      description: 'Förfrågan har gått ut. Börja om från din AI-klient.',
    };
  }

  const personId = await deps.sessions.verify(input.sessionToken);
  if (!personId || !(await deps.people.exists(personId))) {
    return { ok: false, error: 'access_denied', description: 'Du är inte inloggad.' };
  }

  if (!(await deps.pending.consume(record.id, now))) {
    log.warn('oauth.authorize.double_approve', { requestId: record.id });
    return { ok: false, error: 'invalid_request', description: 'Förfrågan är redan behandlad.' };
  }

  if (input.approved === false) {
    log.info('oauth.authorize.declined', { clientId: record.clientId, personId });
    return {
      ok: true,
      redirectUrl: errorRedirect(
        record.redirectUri,
        'access_denied',
        'Personen nekade åtkomst.',
        record.state ?? undefined,
      ),
      personId,
      clientId: record.clientId,
    };
  }

  const code = newAuthorizationCode();

  await deps.codes.create({
    codeHash: hashSecret(code),
    clientId: record.clientId,
    personId,
    redirectUri: record.redirectUri,
    codeChallenge: record.codeChallenge,
    codeChallengeMethod: 'S256',
    scope: record.scope,
    expiresAt: new Date(now.getTime() + deps.config.authorizationCodeTtlSeconds * 1000),
  });

  log.info('oauth.authorize.approved', {
    clientId: record.clientId,
    personId,
    scope: record.scope,
  });

  const target = new URL(record.redirectUri);
  target.searchParams.set('code', code);
  if (record.state !== null) target.searchParams.set('state', record.state);

  return { ok: true, redirectUrl: target.toString(), personId, clientId: record.clientId };
}

function show(error: string, description: string): AuthorizeStart {
  return { kind: 'show', error, description };
}

/**
 * An error delivered to the client, with `state`.
 *
 * `state` has to come back even on failure: it is how the client matches the response to
 * the request it started, and a client that cannot match an error treats it as an
 * unrelated redirect and hangs waiting for the real one.
 */
function errorRedirect(
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state !== undefined) url.searchParams.set('state', state);
  return url.toString();
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
