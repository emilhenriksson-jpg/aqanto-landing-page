/**
 * Helpers every route group needs.
 */

import type { Actor, RoomId, RoomRef, Services } from '@photographic/core';
import { resolveRoomRef } from '@photographic/core';

import type { AppContext } from '../context.js';
import { assertRoomInScope, getActor } from '../context.js';

export { assertRoomInScope, getActor };

export function getServices(c: AppContext): Services {
  return c.get('services');
}

/**
 * Resolves the room a request is about.
 *
 * Thin on purpose: the rule lives in `@photographic/core` because the MCP tools have to
 * answer this identically. Two copies of "no room named means the personal room" is two
 * products depending on which door the person came in through.
 */
export async function resolveRoom(
  c: AppContext,
  actor: Actor,
  ref: RoomRef,
): Promise<RoomId> {
  return resolveRoomRef(getServices(c), actor, ref);
}
