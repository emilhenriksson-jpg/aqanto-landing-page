/**
 * From a bearer token to an `Actor`.
 *
 * This is the narrowest and most consequential function in the package: everything
 * downstream trusts the `Actor` it produces and nothing re-derives it. Three things it
 * must never do.
 *
 * It must never take a person id from the request. The token is the only authority.
 *
 * It must never expand an empty `roomScope` into a list of rooms. Empty means "every room
 * this person belongs to, resolved now", and a token that cached its memberships would
 * keep reading a room after the person left it — the failure nobody notices, because
 * nothing errors.
 *
 * And it must never report which of the failure cases happened. Unknown, revoked and
 * expired are one answer, because the difference tells a holder of a stolen token what
 * kind of stolen token they have.
 */

import { AuthError } from '@photographic/core';
import type { Actor, AgentClient, RoomId, SessionId } from '@photographic/core';

import type { AuthLogger, OAuthClientRecord, OAuthClientStore, PersonLookup } from './deps.js';
import { silentLogger } from './deps.js';
import type { TokenService } from './tokens.js';

export interface ResolveActorDeps {
  tokens: TokenService;
  clients: OAuthClientStore;
  people: PersonLookup;
  logger?: AuthLogger;
}

export interface ResolvedToken {
  actor: Actor;
  clientId: string;
  scope: string;
  tokenId: string;
}

export async function resolveActor(
  rawToken: string,
  deps: ResolveActorDeps,
  options: { sessionId?: SessionId | null; agentClient?: AgentClient } = {},
): Promise<ResolvedToken> {
  const log = deps.logger ?? silentLogger;

  const record = await deps.tokens.verifyAccessToken(rawToken);

  if (!(await deps.people.exists(record.personId))) {
    log.warn('oauth.token.orphaned', { tokenId: record.id });
    throw new AuthError('unknown token');
  }

  // Narrowed tokens are intersected with current memberships on every request. A room the
  // token names but the person has since left resolves to nothing, without an error: the
  // token is still valid, it just reaches less far than it did.
  let roomScope: RoomId[] = [];
  if (record.roomScope.length > 0) {
    const current = await deps.people.accessibleRoomIds(record.personId);
    roomScope = record.roomScope.filter((room) => current.includes(room));

    if (roomScope.length === 0) {
      log.warn('oauth.token.scope_empty', { tokenId: record.id });
      throw new AuthError('token no longer grants access to any room');
    }
  }

  const client = await deps.clients.findByClientId(record.clientId);

  return {
    actor: {
      personId: record.personId,
      agentClient: options.agentClient ?? agentClientOf(client),
      sessionId: options.sessionId ?? null,
      roomScope,
    },
    clientId: record.clientId,
    scope: record.scope,
    tokenId: record.id,
  };
}

/**
 * Which AI a token was issued to, guessed from the name the client registered under.
 *
 * A guess, and labelled as one: `unknown` rather than a plausible-looking default,
 * because this string appears in the person's own history feed next to "sparade" and a
 * confident wrong attribution is worse than an honest blank. MCP connections refine it
 * from `clientInfo` at initialize, which is more precise than registration ever is.
 */
export function agentClientOf(client: OAuthClientRecord | null): AgentClient {
  if (!client) return 'unknown';

  const name = client.clientName.toLowerCase();

  if (name.includes('claude code')) return 'claude-code';
  if (name.includes('claude') && name.includes('mobile')) return 'claude-mobile';
  if (name.includes('claude')) return 'claude-desktop';
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('codex')) return 'codex';
  if (name.includes('chatgpt') || name.includes('openai')) return 'chatgpt-web';

  return 'unknown';
}
