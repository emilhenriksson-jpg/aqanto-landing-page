/**
 * The same claim as `packages/db/src/services/replay.test.ts`, against the reference
 * implementation.
 *
 * Worth having twice rather than once. `AGENTS.md` treats this package as what defines
 * correct behaviour, and the harness comment is blunt about the two backends having already
 * drifted in more than one place — so "the log is the truth" holding on Postgres and not
 * here would be a divergence in the one invariant neither implementation is allowed to lose.
 * It is also the only version of this check that runs with no database at hand.
 *
 * `MemoryEvents.replay` had no caller before this file, in the same way `PgEvents.replay`
 * had none: implemented, exported, and proving nothing.
 */

import type { Actor, RoomId, ShortId } from '@photographic/core';
import { divergencesFrom, replayItemLifecycle } from '@photographic/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMemoryServices, type MemoryServices } from './index.js';

let wired: MemoryServices;
let emil: Actor;
let personalRoom: RoomId;
let sharedRoom: RoomId;

async function save(actor: Actor, roomId: RoomId, body: string): Promise<ShortId> {
  const decision = await wired.services.ingest.remember(actor, { roomId, body, explicit: true });
  if (decision.outcome === 'needs_approval') {
    const item = await wired.services.ingest.resolveProposal(actor, decision.proposal.id, true);
    return item!.shortId;
  }
  return decision.outcome === 'auto' ? decision.item.shortId : decision.existing.shortId;
}

beforeEach(async () => {
  wired = createMemoryServices({});

  const registered = await wired.services.identity.register({
    email: 'emil@replay.test',
    displayName: 'Emil',
  });
  emil = wired.actorFor(registered.person.id, 'claude-desktop');
  personalRoom = registered.personalRoom.id;

  const room = await wired.services.rooms.create(emil, { title: 'Buyersclub Ledning' });
  sharedRoom = room.id;

  await save(emil, personalRoom, 'Allergisk mot ketchup');
  const edited = await save(emil, personalRoom, 'Lanseringen är 15 oktober');
  await save(emil, sharedRoom, 'Budgeten är beslutad');

  // The negation is what `FakeLlm.compare` recognises, so the supersede path is actually
  // reached rather than hoped for.
  await save(emil, personalRoom, 'Jag dricker kaffe på morgonen');
  const contradiction = await wired.services.ingest.remember(emil, {
    roomId: personalRoom,
    body: 'Jag dricker inte kaffe på morgonen',
  });
  if (contradiction.outcome === 'needs_approval') {
    await wired.services.ingest.resolveProposal(emil, contradiction.proposal.id, true);
  }

  await wired.services.ingest.update(emil, edited, personalRoom, 'Lanseringen flyttades');

  const doomed = await save(emil, personalRoom, 'Fel uppgift');
  const { undoToken } = await wired.services.ingest.forget(emil, doomed, personalRoom, 'fel');
  await wired.services.ingest.undo(emil, undoToken);

  const moved = await save(emil, personalRoom, 'Hör hemma i rummet');
  const placement = await wired.services.ingest.move(emil, { shortId: moved, toRoomId: sharedRoom });
  if (placement.outcome === 'needs_approval') {
    await wired.services.ingest.resolveProposal(emil, placement.proposal.id, true);
  }

  const trashed = await save(emil, personalRoom, 'Ligger i papperskorgen');
  await wired.services.ingest.forget(emil, trashed, personalRoom, 'inte längre sant');

  await wired.runJobsToCompletion();
});

// No casts, unlike the Postgres version: the store holds branded ids already, and the
// difference is the point — one side reads rows of raw strings, this one does not.
const projection = () =>
  [...wired.store.items.values()].map((item) => ({
    itemId: item.id,
    roomId: item.roomId,
    status: item.status,
    body: item.body,
  }));

describe('the reference implementation agrees with its own log', () => {
  it('derives every item’s room, status and body from the events alone', async () => {
    const events = await wired.services.events.replay({ limit: 10_000 });

    expect(events.length).toBeGreaterThan(10);
    expect(projection().length).toBeGreaterThan(5);

    expect(divergencesFrom(replayItemLifecycle(events), projection())).toEqual([]);
  });

  it('exercises the transitions that can drift, not only saves', () => {
    const types = new Set(wired.store.allEvents().map((event) => event.eventType));

    expect(types).toContain('item.created');
    expect(types).toContain('item.updated');
    expect(types).toContain('item.superseded');
    expect(types).toContain('item.moved');
    expect(types).toContain('item.deleted');
    expect(types).toContain('item.restored');
    expect(types).toContain('proposal.accepted');
  });

  it('agrees with the trash, which is a second derivation of the same events', async () => {
    const replayed = replayItemLifecycle(await wired.services.events.replay({ limit: 10_000 }));
    const fromLog = [...replayed.values()].filter((item) => item.inTrash).map((item) => item.shortId);

    const trash = await wired.services.trash.list(emil, { limit: 200 });

    expect(trash.map((entry) => entry.shortId).sort()).toEqual([...fromLog].sort());
  });

  it('rebuilds the profile to the same text after the cache is dropped', async () => {
    const before = wired.store.profiles.get(emil.personId)?.rendered;
    expect(before).toContain('ketchup');

    wired.store.profiles.delete(emil.personId);
    const rebuilt = await wired.services.projection.buildProfile(emil.personId);

    expect(rebuilt.rendered).toBe(before);
    // And a trashed memory does not come back through the rebuild, which is the failure
    // that would put deleted text into what every model reads at session start.
    expect(rebuilt.rendered).not.toContain('Ligger i papperskorgen');
  });

  it('rebuilds the room brief to the same text', async () => {
    const before = wired.store.briefs.get(sharedRoom)?.rendered;
    expect(before).toBeTruthy();

    wired.store.briefs.delete(sharedRoom);
    const rebuilt = await wired.services.projection.buildBrief(sharedRoom);

    expect(rebuilt.rendered).toBe(before);
  });
});
