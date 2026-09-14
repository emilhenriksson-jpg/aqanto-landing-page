/**
 * Identity, and the one thing that must happen at the same moment as it.
 */

import type { IdentityPort, Person, PersonId, Room, RoomId } from '@photographic/core';
import { NotFoundError, ValidationError } from '@photographic/core';

import { MemoryStore, newId } from './store.js';

/**
 * Personal rooms carry a fixed slug.
 *
 * The renderer uses it to tell the personal room apart from the rest when listing
 * "rooms you can reach", because the personal room is never one of those: it is the
 * context itself, already rendered above.
 */
export const PERSONAL_ROOM_SLUG = 'personal';

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'rum';
}

export class MemoryIdentity implements IdentityPort {
  constructor(private readonly store: MemoryStore) {}

  /**
   * Registration and the personal room are one operation, not two.
   *
   * Every connected model assumes the personal room exists; it is where the profile
   * comes from. A person who exists without one is a state nothing else in the system
   * knows how to handle, so it cannot be reachable, not even briefly. In Postgres this
   * is one transaction, and the `one_personal_room_per_person` index is what makes the
   * guarantee hold under a concurrent double-submit rather than merely usually.
   */
  async register(input: {
    email?: string;
    phone?: string;
    displayName?: string;
    locale?: string;
  }): Promise<{ person: Person; personalRoom: Room }> {
    const email = input.email?.trim().toLowerCase() ?? null;
    const phone = input.phone?.trim() ?? null;
    if (!email && !phone) {
      throw new ValidationError('Ange e-post eller telefonnummer.');
    }

    if (email && (await this.findByEmail(email))) {
      throw new ValidationError('Det finns redan ett konto för den adressen.');
    }
    if (phone && (await this.findByPhone(phone))) {
      throw new ValidationError('Det finns redan ett konto för det numret.');
    }

    const now = this.store.now();
    const person: Person = {
      id: newId<PersonId>(),
      handle: null,
      // Falling back to the local part gives a new account a name to show before the
      // person has typed one, which is the difference between the connect screen
      // greeting them and greeting nobody.
      displayName: input.displayName ?? email?.split('@')[0] ?? null,
      email,
      phone,
      locale: input.locale ?? 'sv',
      createdAt: now,
    };
    this.store.persons.set(person.id, person);

    const personalRoom: Room = {
      id: newId<RoomId>(),
      kind: 'personal',
      slug: PERSONAL_ROOM_SLUG,
      title: person.displayName ?? 'Mitt rum',
      description: null,
      sensitivity: 'normal',
      createdBy: person.id,
      createdAt: now,
      archivedAt: null,
    };
    this.store.rooms.set(personalRoom.id, personalRoom);
    this.store.addMembership({ personId: person.id, roomId: personalRoom.id, role: 'owner' });

    this.store.append({
      roomId: personalRoom.id,
      eventType: 'room.created',
      payload: { title: personalRoom.title, kind: 'personal' },
      actorPersonId: person.id,
      // Registration is something the person did themselves, through a browser or the
      // phone. Attributing it to an AI would be a lie the history feed then shows.
      agentClient: 'web',
    });

    return { person, personalRoom };
  }

  async findById(id: PersonId): Promise<Person | null> {
    return this.store.persons.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<Person | null> {
    const needle = email.trim().toLowerCase();
    for (const person of this.store.persons.values()) {
      if (person.email === needle) return person;
    }
    return null;
  }

  async findByPhone(phone: string): Promise<Person | null> {
    const needle = phone.trim();
    for (const person of this.store.persons.values()) {
      if (person.phone === needle) return person;
    }
    return null;
  }

  async personalRoomOf(id: PersonId): Promise<Room> {
    const roomId = this.store.personalRoomIdOf(id);
    const room = roomId ? this.store.rooms.get(roomId) : undefined;
    if (!room) throw new NotFoundError('Personen har inget personligt rum.');
    return room;
  }
}
