/**
 * The room headline: one sentence saying what a room is for.
 *
 * Tested apart from the rest of the projection because it is the only derived text that
 * reaches every session for every room, which makes its cost and its wording product
 * decisions rather than implementation details. The rules worth pinning are where the
 * sentence comes from, what it costs to build, and what the room list says about a room
 * whose sentence has not been built yet.
 */

import { describe, expect, it } from 'vitest';

import type { Room, RoomId } from '@photographic/core';
import { FakeLlm } from '@photographic/core/testing';

import { createMemoryServices } from './index.js';

async function setup() {
  const wired = createMemoryServices({ llm: new FakeLlm() });
  const { person } = await wired.services.identity.register({
    email: 'emil@example.com',
    displayName: 'Emil',
  });
  const actor = wired.actorFor(person.id);

  return { ...wired, person, actor, llm: wired.services.llm as FakeLlm };
}

async function roomWith(
  wired: Awaited<ReturnType<typeof setup>>,
  input: { title: string; description?: string; items?: string[] },
): Promise<Room> {
  const room = await wired.services.rooms.create(wired.actor, {
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
  });

  for (const body of input.items ?? []) {
    await wired.services.ingest.remember(wired.actor, {
      roomId: room.id,
      body,
      kind: 'note',
      explicit: true,
    });
  }

  return room;
}

async function headlineOf(
  wired: Awaited<ReturnType<typeof setup>>,
  roomId: RoomId,
): Promise<string> {
  const rooms = await wired.services.rooms.listForPerson(wired.actor);
  return rooms.find((room) => room.roomId === roomId)?.oneLine ?? '';
}

describe('where a room headline comes from', () => {
  it('keeps what the owner wrote, whole', async () => {
    const wired = await setup();
    const room = await roomWith(wired, {
      title: 'Buyersclub Ledning',
      description: 'Ledningsgruppen i Buyersclub. Beslut, underlag och styrelsematerial.',
      items: ['Vi beslutade att skjuta förvärvet till Q3'],
    });
    await wired.runJobsToCompletion();

    // Both sentences. A person who described their room in two meant both, and cutting
    // the second leaves a line that says less than the room's own title.
    expect(await headlineOf(wired, room.id)).toBe(
      'Ledningsgruppen i Buyersclub. Beslut, underlag och styrelsematerial.',
    );
  });

  it('never regenerates over a description the owner wrote', async () => {
    const wired = await setup();
    const room = await roomWith(wired, {
      title: 'Villan',
      description: 'Renovering av villan',
      items: ['Elektrikern heter Micke'],
    });
    await wired.runJobsToCompletion();

    const before = wired.llm.calls.summarise;
    await roomWith(wired, { title: 'Villan 2' });
    await wired.services.ingest.remember(wired.actor, {
      roomId: room.id,
      body: 'Peab har offererat 340 000 kr',
      kind: 'note',
      explicit: true,
    });
    await wired.runJobsToCompletion();

    expect(await headlineOf(wired, room.id)).toBe('Renovering av villan');
    // And the room moving on did not cost a model call it had no use for.
    expect(wired.llm.calls.summarise).toBe(before);
  });

  it('summarises the room when nobody described it', async () => {
    const wired = await setup();
    const room = await roomWith(wired, {
      title: 'Villan',
      items: ['Renoveringen av köket börjar i mars'],
    });
    await wired.runJobsToCompletion();

    expect(await headlineOf(wired, room.id)).toContain('köket');
  });

  it('says a room is empty rather than leaving it unexplained', async () => {
    const wired = await setup();
    const room = await roomWith(wired, { title: 'Nytt rum' });
    await wired.runJobsToCompletion();

    // A model told the room is empty stops trying to answer from it. A model told
    // nothing searches it and reports finding nothing, which reads like a fault.
    expect(await headlineOf(wired, room.id)).toBe('Inget sparat än');
  });

  it('does not summarise the personal room, which is read whole anyway', async () => {
    const wired = await setup();
    const personal = await wired.services.identity.personalRoomOf(wired.person.id);

    await wired.services.ingest.remember(wired.actor, {
      roomId: personal.id,
      body: 'Allergisk mot ketchup',
      kind: 'fact',
      explicit: true,
    });
    await wired.runJobsToCompletion();

    // Saving a fact about yourself is the most frequent write in the product. Paying a
    // model call each time for a sentence the overview replaces with "the profile above
    // is this room" is the kind of cost that only shows up on the invoice.
    expect(wired.llm.calls.summarise).toBe(0);
  });
});

describe('a headline that has not been built yet', () => {
  it('still names the room, so a session never hides one', async () => {
    const wired = await setup();
    const room = await roomWith(wired, {
      title: 'Villan',
      description: 'Renovering av villan',
      items: ['Elektrikern heter Micke'],
    });

    // No jobs run: this is the state a room is in for the seconds after it is created,
    // and a session starting in that window must still see it.
    const rooms = await wired.services.rooms.listForPerson(wired.actor);
    const summary = rooms.find((r) => r.roomId === room.id);

    expect(summary?.title).toBe('Villan');
    expect(summary?.oneLine).toBe('Renovering av villan');
  });

  it('builds nothing on the read path, however many rooms there are', async () => {
    const wired = await setup();
    for (let i = 0; i < 5; i += 1) await roomWith(wired, { title: `Rum ${i}`, items: ['Något'] });

    const before = wired.llm.calls.summarise;
    await wired.services.rooms.listForPerson(wired.actor);

    // Session start is a voice turn. Nobody waits through five summaries.
    expect(wired.llm.calls.summarise).toBe(before);
  });
});
