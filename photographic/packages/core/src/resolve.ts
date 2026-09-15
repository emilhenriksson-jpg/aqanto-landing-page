/**
 * Which room did they mean?
 *
 * Every surface has to answer this, and they all have to answer it the same way, so it
 * is decided here rather than three times. The REST API, the MCP tools and the voice
 * client all take a room the same way a person says it — usually not at all.
 */

import { NotPermittedError } from './errors.js';
import type { Actor, Services } from './ports.js';
import type { RoomId } from './domain.js';

export interface RoomRef {
  /** An id, from a previous result. Checked against the token's own scope. */
  roomId?: string | undefined;
  /** A name, as the person said it. Matched loosely against rooms they belong to. */
  room?: string | undefined;
}

/**
 * Three cases, in the order they matter.
 *
 * No room named at all means the personal room. That is the overwhelmingly common write,
 * and making a model name a room to save "allergisk mot ketchup" is friction on every
 * single call — friction that shows up as the model asking a question instead of just
 * remembering, which is the one thing this product cannot afford to feel like.
 *
 * A name is resolved against the rooms the actor already belongs to, because people say
 * "Buyersclub Ledning" and not a uuid. An unresolvable name is a not-found rather than a
 * validation error, and deliberately so: "no room called that" and "a room called that,
 * which is not yours" have to be the same answer, or the error message becomes a way to
 * enumerate other people's rooms.
 */
export async function resolveRoomRef(
  services: Pick<Services, 'rooms' | 'identity'>,
  actor: Actor,
  ref: RoomRef = {},
): Promise<RoomId> {
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

/**
 * A token may be issued for a subset of the person's rooms.
 *
 * The port still resolves permission itself; this only stops a narrowed token from
 * reaching further than it was issued for, and it fails closed as a not-found like every
 * other denial.
 */
export function assertRoomInScope(actor: Actor, roomId: RoomId): RoomId {
  if (actor.roomScope.length > 0 && !actor.roomScope.includes(roomId)) {
    throw new NotPermittedError();
  }
  return roomId;
}
