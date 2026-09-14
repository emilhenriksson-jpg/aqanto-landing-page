/**
 * Helpers every route group needs.
 */

import type { Actor, RoomId, Services } from '@photographic/core';
import { NotPermittedError } from '@photographic/core';

import type { AppContext } from '../context.js';
import { assertRoomInScope, getActor } from '../context.js';

export { getActor };

export function getServices(c: AppContext): Services {
  return c.get('services');
}

/**
 * Resolves the room a request is about.
 *
 * Three cases, in the order they matter. No room named at all means the personal room:
 * that is the overwhelmingly common write, and making a model name a room to save "is
 * allergic to ketchup" is friction on every single call. A name gets resolved against
 * the rooms the actor already belongs to, because people say "Buyersclub Ledning" and
 * not a uuid. An id is checked against the token's own scope.
 *
 * An unresolvable name is a 404 rather than a 400, and deliberately so: "no room called
 * that" and "a room called that which is not yours" have to be the same answer.
 */
export async function resolveRoom(
  c: AppContext,
  actor: Actor,
  ref: { roomId?: string; room?: string },
): Promise<RoomId> {
  const services = getServices(c);

  if (ref.roomId) {
    return assertRoomInScope(actor, ref.roomId as RoomId);
  }

  if (ref.room) {
    const room = await services.rooms.resolveByName(actor, ref.room);
    if (!room) throw new NotPermittedError('Hittade inget rum med det namnet.');
    return assertRoomInScope(actor, room.id);
  }

  const personal = await services.identity.personalRoomOf(actor.personId);
  return assertRoomInScope(actor, personal.id);
}
