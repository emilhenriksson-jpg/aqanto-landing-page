/**
 * `IdentityPort`: a person and their permanent personal room, created together.
 */

import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type IdentityPort,
  type Person,
    10|  type PersonId,
  type Room,
} from '@photographic/core';

import { createRoom } from './create-room.js';
import type { RoomsDeps } from './deps.js';

const DEFAULT_LOCALE = 'sv-SE';
const FALLBACK_DISPLAY_NAME = 'Mitt minne';

    20|export class IdentityService implements IdentityPort {
  constructor(private readonly deps: RoomsDeps) {}

  /**
   * Creates the person and their personal room in one transaction. A person without a
   * personal room has nowhere to remember anything, so a partial result is worse than
   * a failed signup.
   */
  async register(input: {
    email?: string;
    30|    phone?: string;
    displayName?: string;
    locale?: string;
  }): Promise<{ person: Person; personalRoom: Room }> {
    const email = normaliseEmail(input.email);
    const phone = normalisePhone(input.phone);
    const displayName = input.displayName?.trim().replace(/\s+/g, ' ') || null;

    if (email === null && phone === null && displayName === null) {
      throw new ValidationError('ange e-post, telefonnummer eller namn');
    40|    }

    // Checked here for a readable message; the store's unique indexes are what make it
    // safe under concurrency.
    if (email !== null && (await this.deps.store.people.findByEmail(email)) !== null) {
      throw new ConflictError('det finns redan ett konto med den e-postadressen');
    }
    if (phone !== null && (await this.deps.store.people.findByPhone(phone)) !== null) {
      throw new ConflictError('det finns redan ett konto med det telefonnumret');
    }
    50|
    const locale = input.locale?.trim() || this.deps.config.defaultLocale || DEFAULT_LOCALE;
    const title = displayName ?? nameFromContact(email, phone);

    return this.deps.transaction(async (tx) => {
      const person = await tx.people.create({ displayName, email, phone, locale });

      const personalRoom = await createRoom(tx, {
        kind: 'personal',
        title,
    60|        owner: person.id,
        provenance: {
          actorPersonId: person.id,
          agentClient: this.deps.config.registrationClient ?? 'api',
        },
      });

      return { person, personalRoom };
    });
  }

    70|  async findById(id: PersonId): Promise<Person | null> {
    return this.deps.store.people.findById(id);
  }

  async findByEmail(email: string): Promise<Person | null> {
    const normalised = normaliseEmail(email);
    if (normalised === null) return null;
    return this.deps.store.people.findByEmail(normalised);
  }

    80|  async findByPhone(phone: string): Promise<Person | null> {
    const normalised = normalisePhone(phone);
    if (normalised === null) return null;
    return this.deps.store.people.findByPhone(normalised);
  }

  async personalRoomOf(id: PersonId): Promise<Room> {
    const room = await this.deps.store.rooms.personalRoomOf(id);
    if (room === null) throw new NotFoundError('personligt rum saknas');
    return room;
  }
    90|}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normaliseEmail(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (!EMAIL_PATTERN.test(value)) throw new ValidationError('ogiltig e-postadress');
  return value;
}

   100|export function normalisePhone(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const digits = value.replace(/[\s()\-.]/g, '');
  if (!/^\+?[0-9]{6,15}$/.test(digits)) throw new ValidationError('ogiltigt telefonnummer');
  return digits;
}

/** A room needs a name before the person has told us theirs. */
function nameFromContact(email: string | null, phone: string | null): string {
   110|  const local = email?.split('@')[0]?.replace(/[._-]+/g, ' ').trim();
  if (local) return local.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
  if (phone) return phone;
  return FALLBACK_DISPLAY_NAME;
}
