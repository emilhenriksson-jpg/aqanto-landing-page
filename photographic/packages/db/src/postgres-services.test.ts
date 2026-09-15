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
import { PgJobs } from './services/jobs.js';

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

  itIfDb('purge_trash, run through the queue, purges an item whose deadline has passed', async () => {
    const email = `db-test-${randomUUID()}@example.com`;
    const { person } = await wired!.services.identity.register({ email, displayName: 'Emil' });
    const actor = wired!.actorFor(person.id);
    const room = await wired!.services.identity.personalRoomOf(person.id);

    const saved = await wired!.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Ett minne som snart glöms',
    });
    if (saved.outcome !== 'auto') throw new Error('Väntade ett automatiskt sparande.');

    await wired!.services.ingest.forget(actor, saved.item.shortId, room.id);

    const backdated = await pool!.query(
      `UPDATE app.item SET purge_after = now() - interval '1 second' WHERE short_id = $1`,
      [saved.item.shortId],
    );
    expect(backdated.rowCount).toBe(1);
    expect(await wired!.services.trash.list(actor)).toHaveLength(1);

    // The point of this test: nothing here calls `trash.purgeExpired()`. An explicit
    // enqueue rather than waiting on the recurring chain bootstrapped in
    // `createPostgresServices`, because this file shares one `wired` across every test
    // and an earlier one may already have pulled that chain's next occurrence minutes
    // into the future -- which is a property of sharing a composition root in tests, not
    // of the producer, and this asserts the producer.
    await wired!.services.jobs.enqueue({ kind: 'purge_trash' });
    const ran = await wired!.runJobsToCompletion();
    expect(ran).toBeGreaterThan(0);

    expect(await wired!.services.trash.list(actor)).toHaveLength(0);
  });

  itIfDb('expire_invites, run through the queue, marks an overdue invite as expired', async () => {
    const ownerEmail = `db-test-${randomUUID()}@example.com`;
    const { person } = await wired!.services.identity.register({
      email: ownerEmail,
      displayName: 'Ägare',
    });
    const actor = wired!.actorFor(person.id);
    const room = await wired!.services.rooms.create(actor, { title: `Delat rum ${randomUUID()}` });

    const { invite } = await wired!.services.invites.create(actor, {
      roomId: room.id,
      channel: 'email',
      destination: `guest-${randomUUID()}@example.com`,
    });

    const backdated = await pool!.query(
      `UPDATE app.invite SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [invite.id],
    );
    expect(backdated.rowCount).toBe(1);

    const before = await wired!.services.invites.listForRoom(actor, room.id);
    expect(before[0]?.status).toBe('pending');

    // As above: nothing here calls `invites.expireOverdue()` directly.
    await wired!.services.jobs.enqueue({ kind: 'expire_invites' });
    const ran = await wired!.runJobsToCompletion();
    expect(ran).toBeGreaterThan(0);

    const after = await wired!.services.invites.listForRoom(actor, room.id);
    expect(after[0]?.status).toBe('expired');
  });

  itIfDb('a purge_trash failure is recorded rather than swallowed, and does not stop the runner', async () => {
    // A standalone `PgJobs` against the same pool, rather than a fresh
    // `createPostgresServices` -- that would also bootstrap its own recurring
    // `purge_trash`/`expire_invites` rows, and this test replaces the handler for every
    // row of a kind on the instance it is called on, which would double-count the
    // failure. `PgJobs` is the thing actually under test here: does a handler's
    // rejection reach `last_error` and `failures` rather than disappearing, and does
    // the runner survive it.
    const dedupeKey = `test-purge-failure-${randomUUID()}`;
    const jobs = new PgJobs(pool!);
    jobs.work('purge_trash', async () => {
      throw new Error('kaboom: simulerat purgningsfel');
    });
    await jobs.enqueue({ kind: 'purge_trash', dedupeKey });

    try {
      // A rejection here, rather than the assertions below running at all, is the
      // failure mode this test rules out: a failed sweep is the exact case that a
      // `setInterval` with no `.catch` once turned into a dead process, and
      // `PgJobs.runOnce` is what catches it instead.
      await jobs.runOnce();

      expect(jobs.failures).toHaveLength(1);
      expect(jobs.failures[0]?.kind).toBe('purge_trash');
      expect(String(jobs.failures[0]?.error)).toContain('kaboom');

      const row = await pool!.query<{ last_error: string | null; attempts: number }>(
        `SELECT last_error, attempts FROM app.job WHERE dedupe_key = $1`,
        [dedupeKey],
      );
      expect(row.rows[0]?.last_error).toContain('kaboom');
      expect(row.rows[0]?.attempts).toBe(1);
    } finally {
      // Left unclaimed with attempts below `max_attempts`, this row would otherwise sit
      // in the shared `app.job` table ready to be claimed -- harmlessly, by the real
      // handler, on whichever instance next drains the queue -- but AGENTS.md is clear
      // that a test cleans up after itself rather than counting on that.
      await pool!.query('DELETE FROM app.job WHERE dedupe_key = $1', [dedupeKey]);
    }
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
