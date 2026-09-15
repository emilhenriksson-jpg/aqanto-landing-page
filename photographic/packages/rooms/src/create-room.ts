/**
 * The single room creation path.
 *
 * The personal room is not a special case. Signup and "create a shared room" both come
 * through here: slug, row, owner membership, event. Two code paths is how the personal
 * room ends up without a membership row and invisible to every permission query.
 */

import { ValidationError, type AgentClient, type PersonId, type Room, type RoomKind } from '@photographic/core';

import type { RoomsStore } from './deps.js';
import { uniqueSlug } from './slug.js';

const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;

export interface CreateRoomInput {
  kind: RoomKind;
  title: string;
  description?: string | null;
  /** Becomes the sole owner member. */
  owner: PersonId;
  provenance: {
    actorPersonId: PersonId;
    agentClient?: AgentClient;
    sessionRef?: string;
  };
}

export async function createRoom(store: RoomsStore, input: CreateRoomInput): Promise<Room> {
  const title = input.title.trim().replace(/\s+/g, ' ');
  if (title.length === 0) throw new ValidationError('rummet måste ha ett namn');
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`rummets namn får vara högst ${MAX_TITLE_LENGTH} tecken`);
  }

  const description = input.description?.trim() || null;
  if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`beskrivningen får vara högst ${MAX_DESCRIPTION_LENGTH} tecken`);
  }

  const slug = await uniqueSlug(title, (candidate) => store.rooms.slugTaken(candidate));

  const room = await store.rooms.create({
    kind: input.kind,
    slug,
    title,
    description,
    sensitivity: 'normal',
    createdBy: input.owner,
  });

  await store.memberships.add({
    personId: input.owner,
    roomId: room.id,
    role: 'owner',
    invitedBy: null,
  });

  await store.events.append({
    roomId: room.id,
    eventType: 'room.created',
    payload: { kind: room.kind, slug: room.slug, title: room.title, ownerPersonId: input.owner },
    ...input.provenance,
  });

  return room;
}
