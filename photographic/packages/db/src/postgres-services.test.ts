/**
 * Smoke tests for the Postgres services against a real local database.
 *
 * Skipped rather than failed when no database is reachable, because "no Postgres here"
 * and "Postgres is broken" are different problems and only one of them is this suite's
 * to report. `e2e/src/journey.test.ts` is the real acceptance test; this exists so a
 * regression in the SQL shows up close to the query that caused it rather than three
 * packages away.
 */

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, databaseUrl } from './pool.js';
import { createPostgresServices, type PostgresServices } from './postgres-services.js';

let pool: Pool | null = null;
let wired: PostgresServices | null = null;

async function databaseReachable(): Promise<boolean> {
  const probe = createPool({ connectionString: databaseUrl(), max: 1 });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}

beforeAll(async () => {
  if (!(await databaseReachable())) return;

  pool = createPool({ connectionString: databaseUrl() });
  wired = await createPostgresServices({ pool, baseUrl: 'https://photographic.test' });
});

afterAll(async () => {
  await wired?.close();
});

const itIfDb = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!wired) ctx.skip();
    await fn();
  });

describe('createPostgresServices', () => {
  itIfDb('registers a person with a personal room', async () => {
    const email = `db-test-${randomUUID()}@example.com`;
    const { person, personalRoom } = await wired!.services.identity.register({
      email,
      displayName: 'Testperson',
    });

    expect(personalRoom.kind).toBe('personal');
    expect(personalRoom.createdBy).toBe(person.id);

    const found = await wired!.services.identity.findByEmail(email);
    expect(found?.id).toBe(person.id);

    const actor = wired!.actorFor(person.id);
    const rooms = await wired!.services.rooms.listForPerson(actor);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.kind).toBe('personal');
  });

  itIfDb('remembering a fact rebuilds the profile to contain it', async () => {
    const email = `db-test-${randomUUID()}@example.com`;
    const { person } = await wired!.services.identity.register({ email, displayName: 'Emil' });
    const actor = wired!.actorFor(person.id, 'claude-desktop');
    const room = await wired!.services.identity.personalRoomOf(person.id);

    const result = await wired!.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Allergisk mot ketchup',
    });
    expect(result.outcome).toBe('auto');

    await wired!.runJobsToCompletion();

    const profile = await wired!.services.projection.getProfile(person.id);
    expect(profile.rendered).toContain('ketchup');
  });

  itIfDb('an invited person sees the shared room, not the inviter\'s personal room', async () => {
    const ownerEmail = `db-test-${randomUUID()}@example.com`;
    const guestEmail = `db-test-${randomUUID()}@example.com`;

    const owner = await wired!.services.identity.register({ email: ownerEmail, displayName: 'Ägare' });
    const guest = await wired!.services.identity.register({ email: guestEmail, displayName: 'Gäst' });

    const ownerActor = wired!.actorFor(owner.person.id);
    const room = await wired!.services.rooms.create(ownerActor, { title: `Delat rum ${randomUUID()}` });

    const { url } = await wired!.services.invites.create(ownerActor, {
      roomId: room.id,
      channel: 'email',
      destination: guestEmail,
    });
    const token = url.split('/').filter(Boolean).at(-1)!;

    await wired!.services.invites.accept(token, guest.person.id);

    const guestActor = wired!.actorFor(guest.person.id);
    const rooms = await wired!.services.rooms.listForPerson(guestActor);
    const titles = rooms.map((r) => r.title);

    expect(titles).toContain(room.title);
    expect(titles).not.toContain('Ägare');
    expect(rooms.find((r) => r.kind === 'personal')?.title).toBe('Gäst');
  });
});
