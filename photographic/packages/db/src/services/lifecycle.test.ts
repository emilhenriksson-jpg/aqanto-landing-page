/**
 * Lifecycle transitions, against a real database, with failures injected on purpose.
 *
 * These are the tests the previous suite could not have had, because they assert the thing
 * that was wrong rather than the thing that was easy to read. Three rules run through them.
 *
 * **Nothing here reads `item.status`.** The trash is derived from the log, so a memory's
 * membership of the trash is a question for `TrashPort.list()` and its recoverability a
 * question for `TrashPort.restore()`. The suite that shipped alongside the silent mass
 * deletion asserted `status = 'deleted'`, which the broken code set perfectly well; it was
 * the event it never wrote. A test that reads the column cannot tell the two apart.
 *
 * **Failures are injected between the statements, not simulated.** `failAfter` wraps the
 * pool and rejects the *next* query matching a pattern, wherever in the transaction that
 * lands. That is the crash window the review describes, and the assertion afterwards is not
 * "it recovered" but "the log and `app.item` still agree" — via `replayItemLifecycle`, which
 * rebuilds each memory's state from `app.event` alone.
 *
 * **Every transition is run twice.** Idempotence is the property that makes a retry after a
 * lost response safe, and it is not something the happy path can demonstrate.
 */

import type { Actor, ItemId, ItemStatus, RoomId, ShortId } from '@photographic/core';
import { divergencesFrom, replayItemLifecycle } from '@photographic/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool, createPostgresServices, reset, type PostgresServices } from '../index.js';
import { failOnce } from '../testing/fail-once.js';

const pool = createPool();

let wired: PostgresServices;
let emil: Actor;
let elias: Actor;
let personalRoom: RoomId;
let sharedRoom: RoomId;

beforeEach(async () => {
  await reset(pool);
  wired = await createPostgresServices({ pool });

  const one = await wired.services.identity.register({
    email: 'emil@lifecycle.test',
    displayName: 'Emil',
  });
  emil = wired.actorFor(one.person.id);
  personalRoom = one.personalRoom.id;

  const two = await wired.services.identity.register({
    email: 'elias@lifecycle.test',
    displayName: 'Elias',
  });
  elias = wired.actorFor(two.person.id);

  const room = await wired.services.rooms.create(emil, { title: 'Buyersclub Ledning' });
  sharedRoom = room.id;
  const invite = await wired.services.invites.create(emil, {
    roomId: sharedRoom,
    channel: 'email',
    destination: 'elias@lifecycle.test',
  });
  await wired.services.invites.accept(
    invite.url.split('/').filter(Boolean).at(-1)!,
    elias.personId,
  );
});

afterAll(async () => {
  await pool.end();
});

/** Writes into a room, approving when the gate queues it. Not what these tests are about. */
async function save(actor: Actor, roomId: RoomId, body: string): Promise<ShortId> {
  const decision = await wired.services.ingest.remember(actor, { roomId, body, explicit: true });
  if (decision.outcome === 'needs_approval') {
    const item = await wired.services.ingest.resolveProposal(actor, decision.proposal.id, true);
    return item!.shortId;
  }
  if (decision.outcome === 'auto') return decision.item.shortId;
  return decision.existing.shortId;
}

/**
 * Whether the log and `app.item` still describe the same memories.
 *
 * The single assertion that covers every transition at once, and the reason
 * `EventPort.replay` exists: rebuild each item from `app.event` and compare. An empty list
 * is "the log is the truth" as a checked fact rather than a claim in `AGENTS.md`.
 */
async function divergences() {
  const events = await wired.services.events.replay({ limit: 10_000 });
  const rows = await pool.query<{ id: string; room_id: string; status: ItemStatus; body: string }>(
    `SELECT id, room_id, status, body FROM app.item`,
  );

  return divergencesFrom(
    replayItemLifecycle(events),
    rows.rows.map((row) => ({
      itemId: row.id as ItemId,
      roomId: row.room_id as RoomId,
      status: row.status,
      body: row.body,
    })),
  );
}

const eventTypes = async (itemShortId: ShortId): Promise<string[]> => {
  const rows = await pool.query<{ event_type: string }>(
    `SELECT e.event_type FROM app.event e
     WHERE (e.payload ->> 'short_id') = $1 ORDER BY e.seq`,
    [itemShortId],
  );
  return rows.rows.map((row) => row.event_type);
};

describe('soft delete is one transaction', () => {
  it('puts the memory in the trash, which is a question about the log', async () => {
    const shortId = await save(emil, personalRoom, 'Allergisk mot ketchup');
    await wired.services.ingest.forget(emil, shortId, personalRoom, 'inte längre sant');

    const trash = await wired.services.trash.list(emil);
    expect(trash.map((entry) => entry.shortId)).toContain(shortId);
    expect(trash[0]?.deleteReason).toBe('inte längre sant');
    expect(await divergences()).toEqual([]);
  });

  it('leaves nothing behind when the event append fails', async () => {
    const shortId = await save(emil, personalRoom, 'Allergisk mot ketchup');

    // The exact window the review names: the status change committed and the `item.deleted`
    // did not, which used to leave a memory gone from the room and absent from the trash.
    const injected = failOnce(pool, /INSERT INTO app\.event/);
    const services = (await createPostgresServices({ pool: injected.pool })).services;

    await expect(
      services.ingest.forget(emil, shortId, personalRoom, 'inte längre sant'),
    ).rejects.toThrow(/injected failure/);
    expect(injected.fired()).toBe(true);

    // Rolled back whole: still readable, not in the trash, and the log still agrees.
    const items = await wired.services.retrieval.listForRoom(emil, personalRoom);
    expect(items.map((item) => item.shortId)).toContain(shortId);
    expect(await wired.services.trash.list(emil)).toEqual([]);
    expect(await divergences()).toEqual([]);
  });

  it('is not applied twice by a retry', async () => {
    const shortId = await save(emil, personalRoom, 'Allergisk mot ketchup');
    const first = await wired.services.ingest.forget(emil, shortId, personalRoom);

    // A second delete of the same memory is refused rather than minting a second undo token
    // and moving the purge deadline, which would be two log entries for one deletion.
    await expect(
      wired.services.ingest.forget(emil, shortId, personalRoom),
    ).rejects.toThrow();

    expect((await eventTypes(shortId)).filter((type) => type === 'item.deleted')).toHaveLength(1);
    expect(first.undoToken).toBeTruthy();
  });
});

describe('restore and undo are idempotent', () => {
  it('records one restore for one restore, whichever way it is asked twice', async () => {
    const shortId = await save(emil, personalRoom, 'Allergisk mot ketchup');
    await wired.services.ingest.forget(emil, shortId, personalRoom);

    await wired.services.trash.restore(emil, shortId, personalRoom);
    // The second attempt is the retry a lost response produces. `PgTrash` refuses it because
    // the log says the memory is not in the trash any more.
    await expect(wired.services.trash.restore(emil, shortId, personalRoom)).rejects.toThrow();

    expect((await eventTypes(shortId)).filter((type) => type === 'item.restored')).toHaveLength(1);
    expect(await divergences()).toEqual([]);
  });

  it('never burns an undo token without restoring anything', async () => {
    const shortId = await save(emil, personalRoom, 'Allergisk mot ketchup');
    const { undoToken } = await wired.services.ingest.forget(emil, shortId, personalRoom);

    // `undo` used to clear the token first and restore second. A failure in between spent
    // the one thing whose entire purpose is to be the way back.
    const injected = failOnce(pool, /INSERT INTO app\.event/);
    const services = (await createPostgresServices({ pool: injected.pool })).services;

    await expect(services.ingest.undo(emil, undoToken)).rejects.toThrow(/injected failure/);

    // The token still works, because the transaction that would have spent it rolled back.
    const restored = await wired.services.ingest.undo(emil, undoToken);
    expect(restored.status).toBe('active');
    expect(await wired.services.trash.list(emil)).toEqual([]);
    expect(await divergences()).toEqual([]);
  });

  it('spends the undo token exactly once', async () => {
    const shortId = await save(emil, personalRoom, 'Allergisk mot ketchup');
    const { undoToken } = await wired.services.ingest.forget(emil, shortId, personalRoom);

    await wired.services.ingest.undo(emil, undoToken);
    await expect(wired.services.ingest.undo(emil, undoToken)).rejects.toThrow();

    expect((await eventTypes(shortId)).filter((type) => type === 'item.restored')).toHaveLength(1);
  });
});

describe('accepting a proposal is one transaction', () => {
  it('leaves the proposal answerable when applying it fails', async () => {
    // The failure mode from finding 8: the proposal was marked `accepted` before it was
    // applied, so an interruption left an accepted queue entry with no memory behind it and
    // no way for anything to work out what had happened.
    const decision = await wired.services.ingest.remember(emil, {
      roomId: sharedRoom,
      body: 'Lanseringen är 1 november',
    });
    expect(decision.outcome).toBe('needs_approval');
    if (decision.outcome !== 'needs_approval') return;

    const injected = failOnce(pool, /INSERT INTO app\.item/);
    const services = (await createPostgresServices({ pool: injected.pool })).services;

    await expect(
      services.ingest.resolveProposal(emil, decision.proposal.id, true),
    ).rejects.toThrow(/injected failure/);

    // Still pending, so the person can answer it again — and no orphaned memory.
    const pending = await wired.services.ingest.listProposals(emil);
    expect(pending.map((proposal) => proposal.id)).toContain(decision.proposal.id);

    const items = await wired.services.retrieval.listForRoom(emil, sharedRoom);
    expect(items.map((item) => item.body)).not.toContain('Lanseringen är 1 november');
    expect(await divergences()).toEqual([]);
  });

  it('cannot be answered twice, even from two callers at once', async () => {
    const decision = await wired.services.ingest.remember(emil, {
      roomId: sharedRoom,
      body: 'Lanseringen är 1 november',
    });
    if (decision.outcome !== 'needs_approval') throw new Error('expected the gate to queue');

    // Both start from the same pending proposal. The claim is the `UPDATE ... WHERE status =
    // 'pending'`, so exactly one may proceed and the other is told it is already handled.
    const results = await Promise.allSettled([
      wired.services.ingest.resolveProposal(emil, decision.proposal.id, true),
      wired.services.ingest.resolveProposal(emil, decision.proposal.id, true),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const items = await wired.services.retrieval.listForRoom(emil, sharedRoom);
    expect(items.filter((item) => item.body === 'Lanseringen är 1 november')).toHaveLength(1);
    expect(await divergences()).toEqual([]);
  });

  it('moves the memory rather than copying it when the intent was a move', async () => {
    // A move into a shared room used to be queued as `intent: 'share'`, so saying yes to
    // "flytta p-7k2m till Buyersclub Ledning" left the original in the personal room and
    // added a second copy to the shared one.
    const shortId = await save(emil, personalRoom, 'Budgeten är klar');

    const decision = await wired.services.ingest.move(emil, {
      shortId,
      toRoomId: sharedRoom,
    });
    expect(decision.outcome).toBe('needs_approval');
    if (decision.outcome !== 'needs_approval') return;

    await wired.services.ingest.resolveProposal(emil, decision.proposal.id, true);

    expect(
      (await wired.services.retrieval.listForRoom(emil, personalRoom)).map((item) => item.shortId),
    ).not.toContain(shortId);
    expect(
      (await wired.services.retrieval.listForRoom(emil, sharedRoom)).map((item) => item.shortId),
    ).toContain(shortId);
    expect(await divergences()).toEqual([]);
  });
});

describe('the right to delete is not the right to republish', () => {
  it('lets a room owner remove another member’s contribution', async () => {
    const shortId = await save(elias, sharedRoom, 'Elias underlag');

    // Tidying the room is what owning it buys, and it is visible and reversible.
    await wired.services.ingest.forget(emil, shortId, sharedRoom, 'inte relevant längre');

    const trash = await wired.services.trash.list(elias, { roomId: sharedRoom });
    expect(trash.map((entry) => entry.shortId)).toContain(shortId);
  });

  it('refuses to let that owner move it into another room', async () => {
    const shortId = await save(elias, sharedRoom, 'Elias underlag');
    const other = await wired.services.rooms.create(emil, { title: 'Styrelsen' });

    // Moving hands the text to an audience Elias never chose, and no trash takes a
    // disclosure back. The message the check used to raise said exactly this while the check
    // itself allowed it.
    await expect(
      wired.services.ingest.move(emil, { shortId, fromRoomId: sharedRoom, toRoomId: other.id }),
    ).rejects.toThrow(/Bara den som skrev uppgiften/);

    await expect(
      wired.services.ingest.share(emil, { shortId, fromRoomId: sharedRoom, toRoomId: other.id }),
    ).rejects.toThrow(/Bara den som skrev uppgiften/);
  });

  it('still lets the author move their own contribution', async () => {
    const shortId = await save(elias, sharedRoom, 'Elias underlag');
    const eliasPersonal = await wired.services.identity.personalRoomOf(elias.personId);

    const decision = await wired.services.ingest.move(elias, {
      shortId,
      fromRoomId: sharedRoom,
      toRoomId: eliasPersonal.id,
    });

    // Into their own personal room the audience only narrows, so there is nobody new to
    // protect and it happens directly.
    expect(decision.outcome).toBe('placed');
    expect(await divergences()).toEqual([]);
  });
});

describe('sharing and moving cannot be confirmed by a caller', () => {
  it('queues a proposal for a share no matter what the caller passes', async () => {
    const shortId = await save(emil, personalRoom, 'Allergisk mot ketchup');

    // There is no `confirmed` in the input type any more, and passing one through an untyped
    // caller — a stolen token talking to the REST API by hand — reaches this same code.
    const decision = await wired.services.ingest.share(emil, {
      shortId,
      toRoomId: sharedRoom,
      ...(({ confirmed: true } as unknown) as Record<string, never>),
    });

    expect(decision.outcome).toBe('needs_approval');
    expect(
      (await wired.services.retrieval.listForRoom(emil, sharedRoom)).map((item) => item.body),
    ).not.toContain('Allergisk mot ketchup');
  });

  it('queues a proposal for a move into a shared room the same way', async () => {
    const shortId = await save(emil, personalRoom, 'Allergisk mot ketchup');

    const decision = await wired.services.ingest.move(emil, {
      shortId,
      toRoomId: sharedRoom,
      ...(({ confirmed: true } as unknown) as Record<string, never>),
    });

    expect(decision.outcome).toBe('needs_approval');
    expect(
      (await wired.services.retrieval.listForRoom(emil, personalRoom)).map((item) => item.shortId),
    ).toContain(shortId);
  });
});
