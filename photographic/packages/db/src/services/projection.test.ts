/**
 * `PgProjection` against a real local Postgres. Skipped rather than failed when no
 * database is reachable — see `postgres-services.test.ts` for why.
 *
 * Two properties here that nothing else covers, both of which were quiet rather than
 * broken:
 *
 *  - the Personal Compass reaches a profile that was cached before the compass existed.
 *    `app.profile.compass` defaults to `'[]'`, so an older account read back as having
 *    no compass at all, and whether the block arrived depended on when the account was
 *    created and whether anything had since rebuilt the projection.
 *  - a room headline that is not in the process-local cache asks for a rebuild. The
 *    cache empties on every restart and only a write to the room used to refill it, so
 *    a quiet shared room reached every session as "Inget sparat än" — a statement about
 *    the room, and a false one.
 */

import { randomUUID } from 'node:crypto';

import { COMPASS_PRINCIPLES } from '@photographic/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, databaseUrl } from '../pool.js';
import { createPostgresServices, type PostgresServices } from '../postgres-services.js';

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

async function newPerson() {
  const email = `projection-test-${randomUUID()}@example.com`;
  const { person } = await wired!.services.identity.register({ email, displayName: 'Test' });
  return { person, actor: wired!.actorFor(person.id, 'claude-desktop') };
}

describe('the Personal Compass on a profile that was cached before it existed', () => {
  itIfDb('gives a new account all six code defaults', async () => {
    const { person } = await newPerson();

    const profile = await wired!.services.projection.getProfile(person.id);

    expect(profile.compass).toHaveLength(COMPASS_PRINCIPLES.length);
    expect(profile.compass.map((entry) => entry.key)).toEqual(
      COMPASS_PRINCIPLES.map((principle) => principle.key),
    );
    // Nobody has made a choice, so nothing claims one: default text, and no id to point
    // `list_history` or `update_compass` at.
    expect(profile.compass.every((entry) => entry.source === 'default')).toBe(true);
    expect(profile.compass.every((entry) => entry.shortId === null)).toBe(true);
    expect(profile.compass[0]!.text).toBe(COMPASS_PRINCIPLES[0]!.defaultText);
  });

  itIfDb('gives an account cached before the migration the same six, without a rebuild', async () => {
    const { person } = await newPerson();

    // Exactly the state `0015_personal_compass.sql` leaves behind for a profile that
    // already existed: every other column intact, `compass` at its column default.
    await wired!.services.projection.buildProfile(person.id);
    await pool!.query(`UPDATE app.profile SET compass = '[]'::jsonb WHERE person_id = $1`, [
      person.id,
    ]);
    const versionBefore = (
      await pool!.query<{ version: number }>(
        `SELECT version FROM app.profile WHERE person_id = $1`,
        [person.id],
      )
    ).rows[0]!.version;

    const profile = await wired!.services.projection.getProfile(person.id);

    expect(profile.compass).toHaveLength(COMPASS_PRINCIPLES.length);
    expect(profile.compass.every((entry) => entry.source === 'default')).toBe(true);
    expect(profile.compass[3]!.text).toBe(COMPASS_PRINCIPLES[3]!.defaultText);

    // And it filled the gap in code rather than by writing a new projection from inside
    // a getter: the cached row is untouched, so this cannot depend on a rebuild having
    // run, and two reads in a row cannot disagree.
    const versionAfter = (
      await pool!.query<{ version: number }>(
        `SELECT version FROM app.profile WHERE person_id = $1`,
        [person.id],
      )
    ).rows[0]!.version;
    expect(versionAfter).toBe(versionBefore);
  });

  itIfDb('keeps a personalised principle and defaults the other five', async () => {
    const { person, actor } = await newPerson();
    const key = COMPASS_PRINCIPLES[0]!.key;

    const proposal = await wired!.services.ingest.propose(actor, {
      roomId: (await wired!.services.identity.personalRoomOf(person.id)).id,
      body: 'Var kortfattad. Två meningar räcker nästan alltid.',
      kind: 'compass',
      structured: { compassKey: key },
    });
    await wired!.services.ingest.resolveProposal(actor, proposal.id, true);

    const profile = await wired!.services.projection.getProfile(person.id);
    const own = profile.compass.find((entry) => entry.key === key)!;

    expect(own.source).toBe('personal');
    expect(own.text).toBe('Var kortfattad. Två meningar räcker nästan alltid.');
    expect(own.shortId).not.toBeNull();
    expect(profile.compass.filter((entry) => entry.source === 'default')).toHaveLength(
      COMPASS_PRINCIPLES.length - 1,
    );
  });

  itIfDb('ignores a cached default, so an edit to the built-in text reaches an old account', async () => {
    const { person } = await newPerson();
    await wired!.services.projection.buildProfile(person.id);

    // A cached `default` is a copy of code from the day the projection was built, not a
    // decision. If it were rendered as-is, changing a default in
    // `packages/core/src/compass.ts` would silently fail to reach anyone who signed up
    // before the change.
    await pool!.query(
      `UPDATE app.profile
       SET compass = jsonb_set(compass, '{0,text}', '"Något som inte längre står i koden"')
       WHERE person_id = $1`,
      [person.id],
    );

    const profile = await wired!.services.projection.getProfile(person.id);

    expect(profile.compass[0]!.text).toBe(COMPASS_PRINCIPLES[0]!.defaultText);
    expect(profile.compass[0]!.source).toBe('default');
  });
});

describe('a room headline that is not in the cache', () => {
  itIfDb('asks for a rebuild instead of telling every session the room is empty', async () => {
    const { actor } = await newPerson();
    const room = await wired!.services.rooms.create(actor, { title: 'Buyersclub Ledning' });

    await pool!.query(`DELETE FROM app.job WHERE payload ->> 'roomId' = $1`, [room.id]);

    const headlines = await wired!.services.projection.headlinesFor([room.id]);

    // Still the placeholder right now: session start cannot wait on a summariser.
    expect(headlines.get(room.id)!.stale).toBe(true);

    // But the next session will have something real, because this queued the work.
    const queued = await pool!.query<{ kind: string; dedupe_key: string | null }>(
      `SELECT kind, dedupe_key FROM app.job
       WHERE payload ->> 'roomId' = $1 AND locked_at IS NULL AND failed_at IS NULL`,
      [room.id],
    );
    expect(queued.rows.map((r) => r.kind)).toContain('rebuild_projections');

    // Once per room, not once per session: twenty sessions opening in a minute must not
    // become twenty summariser calls.
    await wired!.services.projection.headlinesFor([room.id]);
    await wired!.services.projection.headlinesFor([room.id]);
    const afterRepeats = await pool!.query<{ count: string }>(
      `SELECT count(*) AS count FROM app.job
       WHERE payload ->> 'roomId' = $1 AND kind = 'rebuild_projections'
         AND locked_at IS NULL AND failed_at IS NULL`,
      [room.id],
    );
    expect(Number(afterRepeats.rows[0]!.count)).toBe(1);
  });

  itIfDb('queues nothing when the owner wrote the description themselves', async () => {
    const { actor } = await newPerson();
    const room = await wired!.services.rooms.create(actor, {
      title: 'Villan',
      description: 'Renovering av villan: offerter, hantverkare och tidplan.',
    });

    await pool!.query(`DELETE FROM app.job WHERE payload ->> 'roomId' = $1`, [room.id]);

    const headlines = await wired!.services.projection.headlinesFor([room.id]);

    expect(headlines.get(room.id)!.rendered).toContain('Renovering av villan');
    // What the owner wrote wins outright and is never regenerated, so there is nothing
    // to ask a model for.
    const queued = await pool!.query<{ count: string }>(
      `SELECT count(*) AS count FROM app.job WHERE payload ->> 'roomId' = $1`,
      [room.id],
    );
    expect(Number(queued.rows[0]!.count)).toBe(0);
  });
});