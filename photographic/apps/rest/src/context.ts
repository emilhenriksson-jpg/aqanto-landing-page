/**
 * The request context shared by every middleware and route.
 */

import type { Actor, RoomId, Services } from '@photographic/core';
import { AuthError, NotPermittedError } from '@photographic/core';
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

/**
 * A token may be issued for a subset of the person's rooms. The port still resolves
 * permission itself; this only stops a narrowed token from reaching further than it
 * was issued for, and it fails closed as a 404 like every other denial.
 */
export function assertRoomInScope(actor: Actor, roomId: RoomId): RoomId {
  if (actor.roomScope.length > 0 && !actor.roomScope.includes(roomId)) {
    throw new NotPermittedError();
  }
  return roomId;
}
