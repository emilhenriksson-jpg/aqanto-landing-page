/**
 * The request context shared by every middleware and route.
 */

import type { Actor, Services } from '@photographic/core';
import { assertRoomInScope, AuthError } from '@photographic/core';
import type { Context } from 'hono';

import type { RestConfig } from './config.js';
import type { Logger } from './logger.js';

export interface AppVariables {
  requestId: string;
  /** `Date.now()` at the very start of the request; used for the 404 timing floor. */
  startedAt: number;
  logger: Logger;
  /** Null until the auth middleware has run, and on unauthenticated routes. */
  actor: Actor | null;
  /**
   * Capabilities the presented token actually carries.
   *
   * Separate from the actor because they answer different questions. The actor is *who*
   * is calling and is resolved from the token; this is *what that token may do*, and it
   * is narrower than the person's own permissions whenever a client asked for less than
   * everything. Empty on unauthenticated routes.
   */
  scopes: string[];
  /** The OAuth client the token was issued to. Null for the first-party web session. */
  clientId: string | null;
  services: Services;
  config: RestConfig;
}

export type AppEnv = { Variables: AppVariables };
export type AppContext = Context<AppEnv>;

/**
 * The actor is the only authority for what a request may see. Nothing else -- not a
 * path parameter, not a body field, not a header -- grants access to anything.
 */
export function getActor(c: AppContext): Actor {
  const actor = c.get('actor');
  if (!actor) throw new AuthError('Du är inte inloggad.');
  return actor;
}

/** Re-exported so route code has one import for the request-scoped helpers. */
export { assertRoomInScope };
