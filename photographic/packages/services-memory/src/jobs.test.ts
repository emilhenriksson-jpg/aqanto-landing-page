/**
 * `purge_trash` and `expire_invites`, run through the job queue rather than called
 * directly.
 *
 * Both handlers used to be registered in `createMemoryServices` and enqueued nowhere, so
 * neither had ever run once. These tests are the proof that giving them a producer
 * actually reaches the real behaviour -- not only that the enqueue call compiles -- and
 * that a sweep which throws is recorded rather than disappearing. See the comment beside
 * `jobs.work('purge_trash', ...)` in `./index.ts` for why the job queue is the one
 * mechanism for both, replacing the `setInterval` and the missing producer it used to be
 * split across.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryServices } from './index.js';

describe('purge_trash, run through the queue', () => {
  it('purges an item whose deadline has passed, with nothing calling purgeExpired directly', async () => {
    const wired = createMemoryServices();
    const { person, personalRoom } = await wired.services.identity.register({
      email: 'emil@example.com',
      displayName: 'Emil',
    });
    const actor = wired.actorFor(person.id);

    const saved = await wired.services.ingest.remember(actor, {
      roomId: personalRoom.id,
      body: 'Ett minne som snart glöms',
    });
    if (saved.outcome !== 'auto') throw new Error('Väntade ett automatiskt sparande.');

    await wired.services.ingest.forget(actor, saved.item.shortId, personalRoom.id);

    // Moves the thirty-day deadline into the past the same way `e2e/src/harness.ts`'s
    // memory driver does for `expireTrash` -- there is no port method for this on
    // purpose, since nothing but the sweep itself is meant to reach it.
    let backdated = false;
    for (const item of wired.store.items.values()) {
      if (item.shortId !== saved.item.shortId) continue;
      item.purgeAfter = new Date(Date.now() - 1000);
      backdated = true;
    }
    expect(backdated).toBe(true);

    expect(await wired.services.trash.list(actor)).toHaveLength(1);

    // The point of this test: nothing here calls `trash.purgeExpired()`. Only the queue.
    const ran = await wired.runJobsToCompletion();
    expect(ran).toBeGreaterThan(0);

    expect(await wired.services.trash.list(actor)).toHaveLength(0);
  });
});

describe('expire_invites, run through the queue', () => {
  it('marks an overdue invite as expired, with nothing calling expireOverdue directly', async () => {
    const wired = createMemoryServices();
    const { person } = await wired.services.identity.register({
      email: 'owner@example.com',
      displayName: 'Ägare',
    });
    const actor = wired.actorFor(person.id);
    const room = await wired.services.rooms.create(actor, { title: 'Delat rum' });

    const { invite } = await wired.services.invites.create(actor, {
      roomId: room.id,
      channel: 'email',
      destination: 'gast@example.com',
    });

    let backdated = false;
    for (const row of wired.store.invites.values()) {
      if (row.invite.id !== invite.id) continue;
      row.invite.expiresAt = new Date(Date.now() - 1000);
      backdated = true;
    }
    expect(backdated).toBe(true);

    const before = await wired.services.invites.listForRoom(actor, room.id);
    expect(before[0]?.status).toBe('pending');

    // As above: nothing here calls `invites.expireOverdue()`. Only the queue.
    const ran = await wired.runJobsToCompletion();
    expect(ran).toBeGreaterThan(0);

    const after = await wired.services.invites.listForRoom(actor, room.id);
    expect(after[0]?.status).toBe('expired');
  });
});

describe('a sweep that fails is recorded rather than swallowed, and does not stop the queue', () => {
  it('purge_trash', async () => {
    const wired = createMemoryServices();
    wired.jobs.work('purge_trash', async () => {
      throw new Error('kaboom: simulerat purgningsfel');
    });

    // A rejection here, rather than the assertions below running at all, is the failure
    // mode this test exists to rule out: a failed sweep is the exact case that a
    // `setInterval` with no `.catch` once turned into a dead process, and
    // `MemoryJobs.runOnce` is what catches it instead.
    await wired.runJobsToCompletion();

    expect(wired.jobs.failures).toHaveLength(1);
    expect(wired.jobs.failures[0]?.kind).toBe('purge_trash');
    expect(String(wired.jobs.failures[0]?.error)).toContain('kaboom');
  });

  it('expire_invites', async () => {
    const wired = createMemoryServices();
    wired.jobs.work('expire_invites', async () => {
      throw new Error('kaboom: simulerat expireringsfel');
    });

    await wired.runJobsToCompletion();

    expect(wired.jobs.failures).toHaveLength(1);
    expect(wired.jobs.failures[0]?.kind).toBe('expire_invites');
    expect(String(wired.jobs.failures[0]?.error)).toContain('kaboom');
  });
});
