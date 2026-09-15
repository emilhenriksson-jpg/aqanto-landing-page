/**
 * The claim `AGENTS.md` makes about the log, checked end to end.
 *
 * Non-negotiable 2 says `item`, `profile`, `brief` and embeddings are projections. That is
 * the entire justification for letting the log be authoritative: if a table and the log
 * disagree, the log wins, and a projection you cannot rebuild is not a projection — it is a
 * second authority nobody named.
 *
 * `lifecycle.test.ts` already asserts the first link of that chain around each individual
 * transition. This file asserts the whole chain after a realistic history, in the direction
 * the claim is actually made:
 *
 *   1. `app.event` → item state. Derived with `replayItemLifecycle` and compared to
 *      `app.item`, so a transition that changed a row without recording it shows up as a
 *      divergence rather than as a memory nobody can explain.
 *   2. item state → `app.profile` / `app.brief`. Thrown away and rebuilt, then compared to
 *      what was cached before, so those rows are demonstrably derived rather than
 *      accumulated.
 *   3. body → embedding. Cleared and backfilled by the ordinary job.
 *
 * The history in `beforeEach` is deliberately not a happy path: it includes a correction
 * that supersedes something, a delete, a restore, a move between rooms and an approval
 * through the queue. Those are the transitions where the log and the tables can drift, and a
 * rebuild over a history of three saves would prove nothing about any of them.
 */

import type { Actor, ItemId, ItemStatus, RoomId, ShortId } from '@photographic/core';
import { divergencesFrom, replayItemLifecycle } from '@photographic/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool, createPostgresServices, reset, type PostgresServices } from '../index.js';

const pool = createPool();

let wired: PostgresServices;
let emil: Actor;
let personalRoom: RoomId;
let sharedRoom: RoomId;

/** Approves whatever the gate queued, which is the only way into a shared room. */
async function save(actor: Actor, roomId: RoomId, body: string): Promise<ShortId> {
  const decision = await wired.services.ingest.remember(actor, { roomId, body, explicit: true });
  if (decision.outcome === 'needs_approval') {
    const item = await wired.services.ingest.resolveProposal(actor, decision.proposal.id, true);
    return item!.shortId;
  }
  return decision.outcome === 'auto' ? decision.item.shortId : decision.existing.shortId;
}

beforeEach(async () => {
  await reset(pool);
  wired = await createPostgresServices({ pool });

  const registered = await wired.services.identity.register({
    email: 'emil@replay.test',
    displayName: 'Emil',
  });
  emil = wired.actorFor(registered.person.id);
  personalRoom = registered.personalRoom.id;

  const room = await wired.services.rooms.create(emil, { title: 'Buyersclub Ledning' });
  sharedRoom = room.id;

  // A history with every kind of drift in it.
  await save(emil, personalRoom, 'Allergisk mot ketchup');
  await save(emil, personalRoom, 'Bor i Stockholm');
  const edited = await save(emil, personalRoom, 'Lanseringen är 15 oktober');
  await save(emil, sharedRoom, 'Budgeten är beslutad');

  // A correction, which supersedes the old value rather than deleting it. The negation is
  // what `FakeLlm.compare` recognises as a contradiction — a real model would not need it,
  // but the fixture has to actually reach the supersede path rather than hope to.
  await save(emil, personalRoom, 'Jag dricker kaffe på morgonen');
  const contradiction = await wired.services.ingest.remember(emil, {
    roomId: personalRoom,
    body: 'Jag dricker inte kaffe på morgonen',
  });
  if (contradiction.outcome === 'needs_approval') {
    await wired.services.ingest.resolveProposal(emil, contradiction.proposal.id, true);
  }

  // An edit, a delete and a restore.
  await wired.services.ingest.update(emil, edited, personalRoom, 'Lanseringen flyttades');
  const doomed = await save(emil, personalRoom, 'Fel uppgift');
  const { undoToken } = await wired.services.ingest.forget(emil, doomed, personalRoom, 'fel');
  await wired.services.ingest.undo(emil, undoToken);

  // A move, which changes which room a memory belongs to.
  const moved = await save(emil, personalRoom, 'Hör hemma i rummet');
  const placement = await wired.services.ingest.move(emil, { shortId: moved, toRoomId: sharedRoom });
  if (placement.outcome === 'needs_approval') {
    await wired.services.ingest.resolveProposal(emil, placement.proposal.id, true);
  }

  // And one memory left in the trash, so the trash's own derivation is covered too.
  const trashed = await save(emil, personalRoom, 'Ligger i papperskorgen');
  await wired.services.ingest.forget(emil, trashed, personalRoom, 'inte längre sant');

  await wired.runJobsToCompletion();
});

afterAll(async () => {
  await pool.end();
});

async function itemRows() {
  const rows = await pool.query<{ id: string; room_id: string; status: ItemStatus; body: string }>(
    `SELECT id, room_id, status, body FROM app.item`,
  );
  return rows.rows.map((row) => ({
    itemId: row.id as ItemId,
    roomId: row.room_id as RoomId,
    status: row.status,
    body: row.body,
  }));
}

describe('app.item is derivable from app.event', () => {
  it('agrees with the log after a history with every kind of transition in it', async () => {
    const events = await wired.services.events.replay({ limit: 10_000 });

    // Not an empty log being trivially consistent: an agreement assertion over nothing
    // passes, so the history has to be shown to exist before it is trusted.
    expect(events.length).toBeGreaterThan(10);
    expect((await itemRows()).length).toBeGreaterThan(5);

    expect(divergencesFrom(replayItemLifecycle(events), await itemRows())).toEqual([]);
  });

  it('covers the transitions that can drift, not only saves', async () => {
    // The point of the fixture. If a future change stops emitting one of these, the
    // divergence assertion above would still pass over a history that no longer exercises
    // it — so the history itself is asserted.
    const types = new Set(
      (await wired.services.events.replay({ limit: 10_000 })).map((event) => event.eventType),
    );

    expect(types).toContain('item.created');
    expect(types).toContain('item.updated');
    expect(types).toContain('item.superseded');
    expect(types).toContain('item.moved');
    expect(types).toContain('item.deleted');
    expect(types).toContain('item.restored');
    expect(types).toContain('proposal.accepted');
  });

  it('puts exactly the memories the log says are deleted in the trash', async () => {
    // `app.trash` is a second derivation of the same events, so the two have to agree with
    // each other as well as with the table. A delete-undo-delete history is what used to
    // give this two answers.
    const replayed = replayItemLifecycle(await wired.services.events.replay({ limit: 10_000 }));
    const fromLog = [...replayed.values()].filter((item) => item.inTrash).map((item) => item.shortId);

    const trash = await wired.services.trash.list(emil, { limit: 200 });

    expect(trash.map((entry) => entry.shortId).sort()).toEqual([...fromLog].sort());
  });
});

describe('app.profile and app.brief are caches, not authorities', () => {
  it('rebuilds the profile to the same text after the cached row is thrown away', async () => {
    const before = await pool.query<{ rendered: string }>(
      `SELECT rendered FROM app.profile WHERE person_id = $1`,
      [emil.personId],
    );
    expect(before.rows[0]?.rendered).toContain('ketchup');

    // The row is the cache. Deleting it is what a restored backup, a schema change or a
    // corrupted projection looks like, and the claim is that none of those loses anything.
    await pool.query(`DELETE FROM app.profile WHERE person_id = $1`, [emil.personId]);
    await wired.services.projection.buildProfile(emil.personId);

    const after = await pool.query<{ rendered: string }>(
      `SELECT rendered FROM app.profile WHERE person_id = $1`,
      [emil.personId],
    );
    expect(after.rows[0]?.rendered).toBe(before.rows[0]?.rendered);
  });

  it('rebuilds the room brief to the same text', async () => {
    const before = await pool.query<{ rendered: string }>(
      `SELECT rendered FROM app.brief WHERE room_id = $1`,
      [sharedRoom],
    );
    expect(before.rows[0]?.rendered).toBeTruthy();

    await pool.query(`DELETE FROM app.brief WHERE room_id = $1`, [sharedRoom]);
    await wired.services.projection.buildBrief(sharedRoom);

    const after = await pool.query<{ rendered: string }>(
      `SELECT rendered FROM app.brief WHERE room_id = $1`,
      [sharedRoom],
    );
    expect(after.rows[0]?.rendered).toBe(before.rows[0]?.rendered);
  });

  it('never rebuilds a memory the log says is deleted back into the profile', async () => {
    // The reason this matters more than a text comparison: a rebuild that read the raw
    // table without its lifecycle state would resurrect trashed text into the one thing
    // every model is handed at session start.
    await pool.query(`DELETE FROM app.profile WHERE person_id = $1`, [emil.personId]);
    const rebuilt = await wired.services.projection.buildProfile(emil.personId);

    expect(rebuilt.rendered).not.toContain('Ligger i papperskorgen');
  });
});

describe('embeddings are recomputed rather than replayed', () => {
  it('backfills a cleared embedding through the ordinary job', async () => {
    // Deliberately not part of the log: an embedding is a function of the body, and
    // recording a thousand floats per memory in an append-only table to avoid one API call
    // would be the wrong trade. `AGENTS.md` says so now rather than implying a replay
    // covers it.
    const before = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM app.item WHERE embedding IS NOT NULL`,
    );
    expect(Number(before.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    await pool.query(`UPDATE app.item SET embedding = NULL`);

    const items = await pool.query<{ id: string }>(
      `SELECT id FROM app.item WHERE status = 'active'`,
    );
    for (const item of items.rows) {
      await wired.jobs.enqueue({ kind: 'embed_item', payload: { itemId: item.id } });
    }
    await wired.runJobsToCompletion();

    const after = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM app.item WHERE embedding IS NOT NULL`,
    );
    expect(Number(after.rows[0]?.count ?? 0)).toBe(items.rowCount);
  });
});
