/**
 * The one place this package decides access.
 *
 * A room id arriving from a model is a request, never a grant: every method resolves
 * the actor's own role before it looks at anything else. Denial always renders as 404
 * through `NotPermittedError`, because confirming that a room exists is already a leak.
 */

import { NotPermittedError, type Actor, type MemberRole, type Room, type RoomId } from '@photographic/core';

    10|import type { RoomsStore } from './deps.js';

const RANK: Record<MemberRole, number> = { viewer: 1, editor: 2, owner: 3 };

export function atLeast(role: MemberRole, minimum: MemberRole): boolean {
  return RANK[role] >= RANK[minimum];
}

/**
 * Resolves the actor's access to one room. Throws the indistinguishable 404 when the
    20| * room does not exist, when the actor is not a member, when the membership has been
 * left, when the room is archived, or when the token was narrowed to other rooms.
 */
export async function requireAccess(
  store: RoomsStore,
  actor: Actor,
  roomId: RoomId,
): Promise<{ room: Room; role: MemberRole }> {
  if (actor.roomScope.length > 0 && !actor.roomScope.includes(roomId)) {
    throw new NotPermittedError();
    30|  }

  const role = await store.rooms.accessRole(actor.personId, roomId);
  if (role === null) throw new NotPermittedError();

  const room = await store.rooms.findById(roomId);
  if (room === null) throw new NotPermittedError();

  return { room, role };
}

    40|/**
 * As `requireAccess`, plus a minimum role. The actor already knows the room exists at
 * this point, so the refusal may say why — it still carries a 404 status.
 */
export async function requireRole(
  store: RoomsStore,
  actor: Actor,
  roomId: RoomId,
  minimum: MemberRole,
  detail: string,
    50|): Promise<{ room: Room; role: MemberRole }> {
  const access = await requireAccess(store, actor, roomId);
  if (!atLeast(access.role, minimum)) throw new NotPermittedError(detail);
  return access;
}

/** Restricts a set of accessible rooms to a token that was narrowed to some of them. */
export function withinScope<T extends { room: Room }>(actor: Actor, rows: T[]): T[] {
  if (actor.roomScope.length === 0) return rows;
    60|  const scope = new Set<RoomId>(actor.roomScope);
  return rows.filter((row) => scope.has(row.room.id));
}

/** Provenance for an event written on an actor's behalf. Never optional. */
export function provenanceOf(actor: Actor): {
  actorPersonId: Actor['personId'];
  agentClient: Actor['agentClient'];
  sessionRef?: string;
} {
    70|  return {
    actorPersonId: actor.personId,
    agentClient: actor.agentClient,
    ...(actor.sessionId ? { sessionRef: actor.sessionId } : {}),
  };
}
