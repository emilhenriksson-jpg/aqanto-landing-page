/**
 * Identity, backed by Postgres.
 *
 * Registration and the personal room are one transaction here for real, not by
 * convention: `room_one_personal_per_person` is a unique index, so a concurrent
 * double-submit fails on the second INSERT rather than merely usually succeeding once.
 */

import type { IdentityPort, Person, PersonId, Room, RoomId } from '@photographic/core';
import { NotFoundError, ValidationError } from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, withTransaction, type Db } from '../pool.js';
import { mapPerson, mapRoom, type PersonRow, type RoomRow } from '../rows.js';
import { PERSONAL_ROOM_SLUG } from '../slug.js';

export class PgIdentity implements IdentityPort {
  constructor(private readonly pool: Pool) {}

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

    return withTransaction(this.pool, async (tx) => {
      const displayName = input.displayName ?? email?.split('@')[0] ?? null;

      const personRow = await queryOne<PersonRow>(
        tx,
        `INSERT INTO app.person (display_name, email, phone, locale)
         VALUES ($1, $2, $3, $4)
         RETURNING id, handle, display_name, email, phone, locale, created_at`,
        [displayName, email, phone, input.locale ?? 'sv'],
      );
      const person = mapPerson(personRow!);

      const title = person.displayName ?? 'Mitt rum';
      const roomRow = await queryOne<RoomRow>(
        tx,
        `INSERT INTO app.room (kind, slug, title, created_by)
         VALUES ('personal', $1, $2, $3)
         RETURNING id, kind, slug, title, description, sensitivity, created_by, created_at, archived_at`,
        [PERSONAL_ROOM_SLUG, title, person.id],
      );
      const personalRoom = mapRoom(roomRow!);

      await tx.query(
        `INSERT INTO app.membership (person_id, room_id, role) VALUES ($1, $2, 'owner')`,
        [person.id, personalRoom.id],
      );

      await tx.query(
        `INSERT INTO app.event (room_id, event_type, payload, actor_person_id, agent_client)
         VALUES ($1, 'room.created', $2, $3, 'web')`,
        [personalRoom.id, JSON.stringify({ title: personalRoom.title, kind: 'personal' }), person.id],
      );

      return { person, personalRoom };
    });
  }

  async findById(id: PersonId): Promise<Person | null> {
    const row = await queryOne<PersonRow>(
      this.pool,
      `SELECT id, handle, display_name, email, phone, locale, created_at
       FROM app.person WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return row ? mapPerson(row) : null;
  }

  async findByEmail(email: string): Promise<Person | null> {
    const row = await queryOne<PersonRow>(
      this.pool,
      `SELECT id, handle, display_name, email, phone, locale, created_at
       FROM app.person WHERE email = $1 AND deleted_at IS NULL`,
      [email.trim().toLowerCase()],
    );
    return row ? mapPerson(row) : null;
  }

  async findByPhone(phone: string): Promise<Person | null> {
    const row = await queryOne<PersonRow>(
      this.pool,
      `SELECT id, handle, display_name, email, phone, locale, created_at
       FROM app.person WHERE phone = $1 AND deleted_at IS NULL`,
      [phone.trim()],
    );
    return row ? mapPerson(row) : null;
  }

  async personalRoomOf(id: PersonId): Promise<Room> {
    const row = await queryOne<RoomRow>(
      this.pool,
      `SELECT r.id, r.kind, r.slug, r.title, r.description, r.sensitivity, r.created_by,
              r.created_at, r.archived_at
       FROM app.room r
       WHERE r.created_by = $1 AND r.kind = 'personal'`,
      [id],
    );
    if (!row) throw new NotFoundError('Personen har inget personligt rum.');
    return mapRoom(row);
  }
}

export async function personalRoomIdOf(db: Db, personId: PersonId): Promise<RoomId | null> {
  const row = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM app.room WHERE created_by = $1 AND kind = 'personal'`,
    [personId],
  );
  return row ? (row.id as RoomId) : null;
}
