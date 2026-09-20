import type { Actor, Room, RoomId } from '@photographic/core';
import { NotPermittedError, privateRoomTitle, ValidationError } from '@photographic/core';
import { slugify } from './identity.js';
import { MemoryStore, newId } from './store.js';

export function assertPrivateRoom(store: MemoryStore, actor: Actor, roomId: RoomId): void {
  const room = store.rooms.get(roomId);
  if (!room || room.createdBy !== actor.personId || room.archivedAt
    || store.roleIn(actor.personId, roomId) !== 'owner'
    || (actor.roomScope.length && !actor.roomScope.includes(roomId))) throw new NotPermittedError();
  if ([...store.memberships.values()].some(m => m.roomId === roomId && m.personId !== actor.personId && !m.leftAt)) {
    throw new ValidationError('Rummet delas med andra. Det här godkännandet gäller bara privata rum.');
  }
}

export function createPrivateRoom(store: MemoryStore, actor: Actor,
  input: { title: string; description?: string; reusePrivate?: boolean }): Room {
  if (actor.roomScope.length) throw new NotPermittedError('En rumsbegränsad koppling kan inte skapa nya rum.');
  const title = privateRoomTitle(input.title);
  if (!title || title.length > 200 || (input.description?.length ?? 0) > 2000) {
    throw new ValidationError('Ange ett rumsnamn på högst 200 tecken och en beskrivning på högst 2000 tecken.');
  }
  if (input.reusePrivate) {
    const matches = [...store.rooms.values()].filter(r => !r.archivedAt && store.canRead(actor.personId, r.id)
      && privateRoomTitle(r.title).toLocaleLowerCase('sv') === title.toLocaleLowerCase('sv'));
    if (matches.length > 1) throw new ValidationError('Flera rum har samma namn. Välj ett tydligare namn.');
    if (matches[0]) { assertPrivateRoom(store, actor, matches[0].id); return matches[0]; }
  }
  const room: Room = { id: newId<RoomId>(), kind: 'shared', slug: slugify(title), title,
    description: input.description?.trim() || null, sensitivity: 'normal', createdBy: actor.personId,
    createdAt: store.now(), archivedAt: null };
  store.rooms.set(room.id, room);
  store.addMembership({ personId: actor.personId, roomId: room.id, role: 'owner' });
  store.append({ roomId: room.id, eventType: 'room.created', payload: { title, kind: 'shared' },
    actorPersonId: actor.personId, agentClient: actor.agentClient, clientId: actor.clientId ?? null,
    sessionRef: actor.sessionId });
  return room;
}
