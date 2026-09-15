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

  itIfDb('a compass proposal, once approved, replaces the default for that slot', async () => {
    const email = `db-test-${randomUUID()}@example.com`;
    const { person } = await wired!.services.identity.register({ email, displayName: 'Emil' });
    const actor = wired!.actorFor(person.id, 'claude-desktop');
    const room = await wired!.services.identity.personalRoomOf(person.id);

    // Untouched, a brand-new account still gets all six — the defaults live in code,
    // not as rows, so this must hold with zero items written.
    const before = await wired!.services.projection.getProfile(person.id);
    expect(before.compass).toHaveLength(6);
    expect(before.compass.every((entry) => entry.source === 'default')).toBe(true);

    const proposal = await wired!.services.ingest.propose(actor, {
      roomId: room.id,
      body: 'Hoppa över all inledande artighet helt.',
      kind: 'compass',
      structured: { compassKey: 'directness' },
    });
    expect(proposal.structured).toEqual({ compassKey: 'directness' });

    const item = await wired!.services.ingest.resolveProposal(actor, proposal.id, true);
    expect(item?.kind).toBe('compass');
    expect(item?.structured).toEqual({ compassKey: 'directness' });

    await wired!.runJobsToCompletion();
    await wired!.services.projection.invalidate({ personId: person.id });
    const after = await wired!.services.projection.getProfile(person.id);

    const directness = after.compass.find((entry) => entry.key === 'directness');
    expect(directness?.source).toBe('personal');
    expect(directness?.text).toBe('Hoppa över all inledande artighet helt.');
    // The other five are untouched defaults.
    expect(after.compass.filter((entry) => entry.source === 'default')).toHaveLength(5);

    // A second proposal for the same slot supersedes the first rather than sitting
    // beside it — one active item per slot, always.
    const second = await wired!.services.ingest.propose(actor, {
      roomId: room.id,
      body: 'Var kort, ingen inledning alls.',
      kind: 'compass',
      structured: { compassKey: 'directness' },
    });
    expect(second.conflictsWith).toBe(item?.id);
    await wired!.services.ingest.resolveProposal(actor, second.id, true);

    await wired!.services.projection.invalidate({ personId: person.id });
    const final = await wired!.services.projection.getProfile(person.id);
    const directnessSlots = final.compass.filter((entry) => entry.key === 'directness');
    expect(directnessSlots).toHaveLength(1);
    expect(directnessSlots[0]?.text).toBe('Var kort, ingen inledning alls.');
  });

  itIfDb('refuses a compass write through remember even with explicit set', async () => {
    const email = `db-test-${randomUUID()}@example.com`;
    const { person } = await wired!.services.identity.register({ email, displayName: 'Emil' });
    const actor = wired!.actorFor(person.id, 'claude-desktop');
    const room = await wired!.services.identity.personalRoomOf(person.id);

    await expect(
      wired!.services.ingest.remember(actor, {
        roomId: room.id,
        body: 'Var alltid extremt kort.',
        kind: 'compass' as never,
        explicit: true,
      }),
    ).rejects.toThrow(/förslag/);
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
