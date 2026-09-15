/**
 * The event log and the calendar, end to end against both backends.
 *
 * Separate from `journey.test.ts` because that file is the acceptance test for the
 * product promise and this one is the acceptance test for the claim underneath it: that
 * the log is the truth, that the calendar is a view over it rather than a second store,
 * and that a memory can answer all six provenance questions rather than the four that
 * were easy.
 *
 * Same harness, so every assertion here runs against the reference implementation and
 * against the real schema. The parts most likely to disagree are exactly the ones this
 * file is about — a view, a trigger, and a jsonb payload.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness } from './harness.js';

// `any` for the reason written out in `journey.test.ts`, and measured at the same time:
// typing it surfaces 70 narrowing errors in the assertions below. Worth fixing, and worth
// fixing on its own rather than inside a change that has to stay reviewable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let harness: any;

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://photographic:photographic@127.0.0.1:5432/photographic';

// Static import and no skip branch, for the reason written out at the top of
// `journey.test.ts`: a harness that cannot be built has to fail, not report green.
beforeAll(async () => {
  harness = await createHarness({ databaseUrl: DATABASE_URL });
});

afterAll(async () => {
  await harness?.teardown();
});

/** `YYYY-MM-DD` for right now, on the clock the calendar uses. */
function today(): string {
  return new Date().toLocaleDateString('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

describe('the day, as a view over the log', () => {
  const email = `kalender-${randomUUID()}@example.com`;

  it('puts a private save in the day it happened, with its reason', async () => {
    const person = await harness.registerPerson(email, 'Emil');
    const actor = harness.actorFor(person.person, 'claude-desktop');
    const room = await harness.services.identity.personalRoomOf(actor.personId);

    await harness.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Dottern heter Vera',
    });

    const day = await harness.services.calendar.day(actor, { date: today() });
    const saved = day.entries.find(
      (entry: { kind: string }) => entry.kind === 'saved_private',
    );

    // Not `saved_to_room`: where something went is the thing the day is a record of, and
    // the two read completely differently to the person.
    expect(saved).toBeTruthy();
    expect(saved.body).toBe('Dottern heter Vera');

    // Every automatic action owes the person a sentence they can read. A model that did
    // not write one must not turn into a blank.
    expect(saved.provenance.motivation).toBeTruthy();
    expect(saved.provenance.agentClient).toBe('claude-desktop');
    expect(saved.provenance.roomKind).toBe('personal');
    // Derived rather than stored: a client plus a session is a conversation.
    expect(saved.provenance.source.kind).toBe('conversation');
  });

  it('shows a correction and the value it corrected, on one line', async () => {
    const actor = await harness.actorForEmail(email, 'claude-desktop');
    const room = await harness.services.identity.personalRoomOf(actor.personId);

    const saved = await harness.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Lanseringen är 15 oktober',
      kind: 'decision',
    });
    const decision = await harness.services.ingest.update(
      actor,
      saved.item.shortId,
      room.id,
      'Lanseringen är 1 november',
    );
    expect(decision.outcome).toBe('updated');

    const day = await harness.services.calendar.day(actor, { date: today() });
    const edit = day.entries.find((entry: { kind: string }) => entry.kind === 'updated');

    // The scope's own example. The current memory says 1 november; the history has to say
    // how we got there, which means keeping both values rather than one.
    expect(edit.body).toBe('Lanseringen är 1 november');
    expect(edit.previousBody).toBe('Lanseringen är 15 oktober');
  });

  it('reads a day forwards and steps to a day that has something in it', async () => {
    const actor = await harness.actorForEmail(email);

    const day = await harness.services.calendar.day(actor, { date: today() });

    // Ascending, unlike the history feed: a day is read forwards.
    const seqs = day.entries.map((entry: { seq: number }) => entry.seq);
    expect([...seqs].sort((a: number, b: number) => a - b)).toEqual(seqs);

    // Nothing later today, and nothing before it either for this person — the arrows
    // point at days that exist rather than at tomorrow.
    expect(day.nextDate).toBeNull();

    const empty = await harness.services.calendar.day(actor, { date: '2020-01-01' });
    expect(empty.entries).toHaveLength(0);
    expect(empty.nextDate).toBe(today());
  });

  it('zooms from the day to the event to the source it came from', async () => {
    const actor = await harness.actorForEmail(email, 'claude-desktop');
    const day = await harness.services.calendar.day(actor, { date: today() });
    const edit = day.entries.find((entry: { kind: string }) => entry.kind === 'updated');

    const detail = await harness.services.calendar.event(actor, edit.seq);

    // Every value the memory has held, oldest first: the original and each correction.
    expect(detail.revisions.map((r: { body: string }) => r.body)).toEqual([
      'Lanseringen är 15 oktober',
      'Lanseringen är 1 november',
    ]);
    expect(detail.currentBody).toBe('Lanseringen är 1 november');
    expect(detail.timeline.length).toBeGreaterThanOrEqual(2);

    // And the last step of the zoom: the source as a place rather than a label.
    expect(detail.source.kind).toBe('conversation');
  });

  it('answers "how do you know that about me?" with a source and a reason', async () => {
    const actor = await harness.actorForEmail(email);
    const day = await harness.services.calendar.day(actor, { date: today() });
    const saved = day.entries.find((entry: { kind: string }) => entry.kind === 'saved_private');

    const provenance = await harness.services.history.provenance(actor, saved.shortId);

    expect(provenance.motivation).toBeTruthy();
    expect(provenance.source).toBeTruthy();
    expect(provenance.changed).toBe(false);
  });

  it('keeps the deleted event in the day it was deleted', async () => {
    const actor = await harness.actorForEmail(email, 'claude-desktop');
    const room = await harness.services.identity.personalRoomOf(actor.personId);

    const saved = await harness.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Bor i Malmö',
    });
    await harness.services.ingest.forget(
      actor,
      saved.item.shortId,
      room.id,
      'Flyttade till Stockholm',
    );

    const day = await harness.services.calendar.day(actor, { date: today() });
    const deleted = day.entries.find((entry: { kind: string }) => entry.kind === 'deleted');

    // A memory event does not vanish because the memory did. The person's own phrasing is
    // what makes the record readable a week later.
    expect(deleted.body).toBe('Bor i Malmö');
    expect(deleted.provenance.motivation).toBe('Flyttade till Stockholm');

    // And the trash is the same log, read differently.
    const [entry] = await harness.services.trash.list(actor);
    expect(entry.shortId).toBe(saved.item.shortId);
    expect(entry.deleteReason).toBe('Flyttade till Stockholm');
  });

  it('holds one trash entry after delete, undo, delete', async () => {
    // The reason the trash is derived rather than stored. Two records of the same fact is
    // one record and one thing that drifts from it, and you find out they disagree when a
    // person sees something they restored last week.
    const actor = await harness.actorForEmail(email, 'claude-desktop');
    const room = await harness.services.identity.personalRoomOf(actor.personId);

    const saved = await harness.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Spelar innebandy på tisdagar',
    });

    const first = await harness.services.ingest.forget(actor, saved.item.shortId, room.id);
    await harness.services.ingest.undo(actor, first.undoToken);
    await harness.services.ingest.forget(actor, saved.item.shortId, room.id, 'slutade');

    const entries = await harness.services.trash.list(actor);
    const matching = entries.filter(
      (entry: { shortId: string }) => entry.shortId === saved.item.shortId,
    );

    expect(matching).toHaveLength(1);
    expect(matching[0].deleteReason).toBe('slutade');
  });
});

describe('what automation may not do', () => {
  const owner = `agare-${randomUUID()}@example.com`;
  const member = `medlem-${randomUUID()}@example.com`;

  it('refuses to place a memory in a shared room without a person saying so', async () => {
    const person = await harness.registerPerson(owner, 'Emil');
    const actor = harness.actorFor(person.person, 'claude-desktop');
    const room = await harness.services.rooms.create(actor, { title: 'Buyersclub Ledning' });

    // Not a rejection of the request — a question. `explicit` is a claim a model makes
    // from text it read, and some of that text arrives in documents we did not write.
    const decision = await harness.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Vi beslutade att skjuta förvärvet till Q3',
      kind: 'decision',
      explicit: true,
    });

    expect(decision.outcome).toBe('needs_approval');
    expect(await harness.services.retrieval.listForRoom(actor, room.id)).toHaveLength(0);
  });

  it('records who wrote what, and shows it in the room owner’s day', async () => {
    const emil = await harness.personByEmail(owner);
    const emilActor = harness.actorFor(emil, 'web');
    const room = await harness.roomByTitle(emilActor, 'Buyersclub Ledning');

    const [pending] = await harness.services.ingest.listProposals(emilActor);
    await harness.services.ingest.resolveProposal(emilActor, pending.id, true);

    const anna = await harness.registerPerson(member, 'Anna');
    const { url } = await harness.services.invites.create(emilActor, {
      roomId: room.id,
      channel: 'email',
      destination: member,
    });
    await harness.services.invites.accept(harness.tokenFromUrl(url), anna.person.id);

    const annaActor = harness.actorFor(anna.person, 'chatgpt-web');
    await harness.saveIntoRoom(annaActor, {
      roomId: room.id,
      body: 'Anna äger due diligence',
      kind: 'fact',
    });

    // No owner moderation of incoming material, so the owner's day has to make other
    // people's contributions the thing they see rather than a line reading like their own.
    const day = await harness.services.calendar.day(emilActor, {
      date: today(),
      roomId: room.id,
    });

    expect(day.byOthersCount).toBeGreaterThan(0);
    const fromAnna = day.entries.find(
      (entry: { byOtherMember: boolean; body: string | null }) =>
        entry.byOtherMember && entry.body === 'Anna äger due diligence',
    );
    expect(fromAnna).toBeTruthy();
    expect(fromAnna.provenance.actorName).toBe('Anna');

    // And Anna's own day does not mark her own write as somebody else's.
    const annaDay = await harness.services.calendar.day(annaActor, {
      date: today(),
      roomId: room.id,
    });
    expect(
      annaDay.entries.every(
        (entry: { byOtherMember: boolean; body: string | null }) =>
          entry.body !== 'Anna äger due diligence' || !entry.byOtherMember,
      ),
    ).toBe(true);
  });

  it('will not let one member quietly delete another member’s contribution', async () => {
    const emil = await harness.personByEmail(owner);
    const anna = await harness.personByEmail(member);
    const emilActor = harness.actorFor(emil, 'web');
    const annaActor = harness.actorFor(anna, 'web');
    const room = await harness.roomByTitle(emilActor, 'Buyersclub Ledning');

    const items = await harness.services.retrieval.listForRoom(annaActor, room.id);
    const emilsLine = items.find((item: { body: string }) => item.body.includes('förvärvet'));

    // Anna can write in the room, so she could delete anything in it. The author owns
    // their own contribution and the owner tidies up; everyone else disputes it, which is
    // a different act with a different outcome.
    await expect(
      harness.services.ingest.forget(annaActor, emilsLine.shortId, room.id),
    ).rejects.toThrow();

    expect(await harness.services.retrieval.listForRoom(emilActor, room.id)).toHaveLength(
      items.length,
    );
  });

  it('lets an invitation be redeemed exactly once', async () => {
    const emil = await harness.personByEmail(owner);
    const emilActor = harness.actorFor(emil, 'web');
    const room = await harness.roomByTitle(emilActor, 'Buyersclub Ledning');

    const { url } = await harness.services.invites.create(emilActor, {
      roomId: room.id,
      channel: 'email',
      destination: `forst-${randomUUID()}@example.com`,
    });
    const token = harness.tokenFromUrl(url);

    const first = await harness.registerPerson(`forst-${randomUUID()}@example.com`, 'Först');
    await harness.services.invites.accept(token, first.person.id);

    // An invite link travels through email, screenshots and forwards, and "it only works
    // once" is the only assumption a person actually makes about one.
    const second = await harness.registerPerson(`sen-${randomUUID()}@example.com`, 'Sen');
    await expect(harness.services.invites.accept(token, second.person.id)).rejects.toThrow();

    // And a spent link stops being a window into the room at all.
    expect(await harness.services.invites.peek(token)).toBeNull();
  });

  it('keeps a departing member’s contributions in the room', async () => {
    const emil = await harness.personByEmail(owner);
    const anna = await harness.personByEmail(member);
    const emilActor = harness.actorFor(emil, 'web');
    const annaActor = harness.actorFor(anna, 'web');
    const room = await harness.roomByTitle(emilActor, 'Buyersclub Ledning');

    const before = await harness.services.retrieval.listForRoom(emilActor, room.id);
    await harness.services.rooms.leave(annaActor, room.id);

    // Her forty notes not vanishing is the promise: otherwise everyone else's memory
    // changes behind their backs, and decisions citing her material stop making sense.
    const after = await harness.services.retrieval.listForRoom(emilActor, room.id);
    expect(after).toHaveLength(before.length);
    expect(after.some((item: { body: string }) => item.body.includes('due diligence'))).toBe(true);

    // Access stops at the next call, without any token being revoked.
    const rooms = await harness.services.rooms.listForPerson(annaActor);
    expect(rooms.map((r: { title: string }) => r.title)).not.toContain('Buyersclub Ledning');

    // And the room's day records that it happened, rather than just quietly losing her.
    const history = await harness.services.history.list(emilActor, { roomId: room.id });
    expect(history.some((entry: { action: string }) => entry.action === 'member_left')).toBe(true);
  });
});

describe('two members who disagree', () => {
  const owner = `tvist-a-${randomUUID()}@example.com`;
  const other = `tvist-b-${randomUUID()}@example.com`;

  it('keeps both statements and settles nothing on its own', async () => {
    const emil = await harness.registerPerson(owner, 'Emil');
    const emilActor = harness.actorFor(emil.person, 'web');
    const room = await harness.services.rooms.create(emilActor, { title: 'Lansering' });

    await harness.saveIntoRoom(emilActor, {
      roomId: room.id,
      body: 'Lanseringen är 15 oktober',
      kind: 'decision',
    });

    const jacob = await harness.registerPerson(other, 'Jacob');
    const { url } = await harness.services.invites.create(emilActor, {
      roomId: room.id,
      channel: 'email',
      destination: other,
    });
    await harness.services.invites.accept(harness.tokenFromUrl(url), jacob.person.id);

    const jacobActor = harness.actorFor(jacob.person, 'claude-desktop');
    await harness.saveIntoRoom(jacobActor, {
      roomId: room.id,
      body: 'Lanseringen är inte 15 oktober',
      kind: 'decision',
    });

    // Whoever wrote last is not whoever is right. Superseding across authors would let
    // anyone in the room overwrite anyone else, with the other person finding out when
    // their own AI answers wrongly.
    const items = await harness.services.retrieval.listForRoom(emilActor, room.id);
    const bodies = items.map((item: { body: string }) => item.body);
    expect(bodies).toContain('Lanseringen är 15 oktober');
    expect(bodies).toContain('Lanseringen är inte 15 oktober');

    const [dispute] = await harness.services.ingest.listDisputes(emilActor);
    expect(dispute.sides).toHaveLength(2);
    expect(dispute.sides.map((side: { authorName: string }) => side.authorName).sort()).toEqual([
      'Emil',
      'Jacob',
    ]);
  });

  it('never hands a model one side of a disagreement alone', async () => {
    const emil = await harness.personByEmail(owner);
    const emilActor = harness.actorFor(emil, 'claude-desktop');

    // A model given one of two contradictory statements answers confidently and wrongly.
    // Given both, it says there are two answers — which is true, and is what gets a
    // person to settle it.
    const hits = await harness.services.retrieval.search(emilActor, { query: 'lanseringen' });
    const disputed = hits.filter((hit: { disputed: boolean }) => hit.disputed);

    expect(disputed.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the disagreement as its own kind of day, not as an edit', async () => {
    const emil = await harness.personByEmail(owner);
    const emilActor = harness.actorFor(emil, 'web');
    const room = await harness.roomByTitle(emilActor, 'Lansering');

    const day = await harness.services.calendar.day(emilActor, { date: today(), roomId: room.id });
    const dispute = day.entries.find((entry: { kind: string }) => entry.kind === 'disputed');

    // The eighth row. Nothing changed, which is exactly why it cannot hide under
    // "uppdaterat", and two people disagreeing is not something to go looking for.
    expect(dispute).toBeTruthy();
    expect(dispute.disputes).toHaveLength(2);
    expect(dispute.byOtherMember).toBe(true);
  });

  it('lets a person settle it, and only a person', async () => {
    const emil = await harness.personByEmail(owner);
    const emilActor = harness.actorFor(emil, 'web');

    const [dispute] = await harness.services.ingest.listDisputes(emilActor);
    const mine = dispute.sides.find((side: { authorName: string }) => side.authorName === 'Emil');
    const theirs = dispute.sides.find((side: { authorName: string }) => side.authorName === 'Jacob');

    const winner = await harness.services.ingest.resolveDispute(emilActor, {
      winnerShortId: mine.shortId,
      loserShortId: theirs.shortId,
      roomId: dispute.roomId,
      resolution: 'bekräftat med styrelsen',
    });

    expect(winner.shortId).toBe(mine.shortId);
    expect(await harness.services.ingest.listDisputes(emilActor)).toHaveLength(0);

    // The loser leaves the current state the one way anything leaves it — superseded,
    // with an event saying so, rather than deleted or silently hidden.
    const bodies = (await harness.services.retrieval.listForRoom(emilActor, dispute.roomId)).map(
      (item: { body: string }) => item.body,
    );
    expect(bodies).toContain(mine.body);
    expect(bodies).not.toContain(theirs.body);

    const history = await harness.services.history.list(emilActor, { roomId: dispute.roomId });
    expect(history.some((entry: { action: string }) => entry.action === 'superseded')).toBe(true);
  });
});

/**
 * Automatic routing: Photographic decides where a memory belongs when nobody said.
 *
 * The three properties worth an end-to-end test are the ones that would be catastrophic
 * rather than annoying if they broke — nothing reaches a shared room on its own, the
 * reason is recorded in the log at the moment of the decision, and uncertainty resolves
 * towards private.
 */
describe('deciding where a memory belongs', () => {
  const email = `routing-${randomUUID()}@example.com`;

  it('keeps something about the person private, and says why in Swedish', async () => {
    const person = await harness.registerPerson(email, 'Emil');
    const actor = harness.actorFor(person.person, 'claude-desktop');

    // No room named. This used to mean "the personal room" by default; now it means
    // Photographic decides.
    const decision = await harness.services.ingest.remember(actor, {
      body: 'Allergisk mot skaldjur',
    });

    expect(decision.outcome).toBe('auto');
    expect(decision.routing.placement).toBe('private');

    const personal = await harness.services.identity.personalRoomOf(actor.personId);
    expect(decision.item.roomId).toBe(personal.id);

    // Recorded at decision time, in the log, phrased for a person — not reconstructed
    // later from a room list that has since changed.
    const day = await harness.services.calendar.day(actor, { date: today() });
    const saved = day.entries.find(
      (entry: { body: string | null }) => entry.body === 'Allergisk mot skaldjur',
    );
    expect(saved.provenance.motivation).toBe('Sparat privat eftersom det handlar om dig.');
  });

  it('finds the room a memory is plainly about — and still asks first', async () => {
    const actor = await harness.actorForEmail(email, 'claude-desktop');
    const room = await harness.services.rooms.create(actor, { title: 'Villan' });
    await harness.services.rooms.describe(
      actor,
      room.id,
      'Renovering av villan: offerter, hantverkare och tidplan',
    );

    // A room earns its subject matter. An empty room with one line of description is
    // genuinely weak evidence, and the router treating it as weak is the correct
    // behaviour — so this puts something in the room first, the way a real one fills up.
    await harness.saveIntoRoom(actor, {
      roomId: room.id,
      body: 'Renoveringen av köket börjar i mars',
      kind: 'note',
    });
    await harness.saveIntoRoom(actor, {
      roomId: room.id,
      body: 'Elektrikern heter Micke',
      kind: 'fact',
    });

    const decision = await harness.services.ingest.remember(actor, {
      body: 'Hantverkarna lämnar offert på tidplanen för villan',
    });

    // Routed to the room, and queued rather than written. The router picks a target; the
    // approval gate decides whether it lands, exactly as for a hand-named room.
    expect(decision.routing.placement).toBe('room');
    expect(decision.routing.roomTitle).toBe('Villan');
    expect(decision.outcome).toBe('needs_approval');

    // The person clearing the queue is told which room and why, not just that a rule fired.
    expect(decision.proposal.reason).toContain('Villan');

    // Nothing landed. The two memories placed above are there; the routed one is not.
    const bodies = (await harness.services.retrieval.listForRoom(actor, room.id)).map(
      (item: { body: string }) => item.body,
    );
    expect(bodies).not.toContain('Hantverkarna lämnar offert på tidplanen för villan');
  });

  it('records the routing reason once the person approves', async () => {
    const actor = await harness.actorForEmail(email, 'claude-desktop');
    const [pending] = await harness.services.ingest.listProposals(actor);
    const item = await harness.services.ingest.resolveProposal(actor, pending.id, true);

    const room = await harness.roomByTitle(actor, 'Villan');
    const day = await harness.services.calendar.day(actor, { date: today(), roomId: room.id });
    const placed = day.entries.find(
      (entry: { shortId: string | null }) => entry.shortId === item.shortId,
    );

    expect(placed.provenance.motivation).toMatch(/^Hör till Villan eftersom det nämner /);
  });

  it('stays private when two rooms match about equally', async () => {
    const actor = await harness.actorForEmail(email, 'claude-desktop');
    const second = await harness.services.rooms.create(actor, { title: 'Villan i Dalarna' });
    await harness.services.rooms.describe(
      actor,
      second.id,
      'Renovering av villan: offerter, hantverkare och tidplan',
    );
    await harness.saveIntoRoom(actor, {
      roomId: second.id,
      body: 'Renoveringen av köket börjar i mars',
      kind: 'note',
    });

    // Matches both rooms through the description they share, and neither through its title.
    const decision = await harness.services.ingest.remember(actor, {
      body: 'Offerten på tidplanen ska in före midsommar',
    });

    // Two rooms matching about equally is a question, not a coin toss. Private is the
    // reversible answer: a memory in the wrong room can be moved, a memory four people
    // have already read cannot be unread.
    expect(decision.routing.placement).toBe('private');
    expect(decision.outcome).toBe('auto');
    expect(decision.routing.uncertainty).toMatch(/både/);
  });

  it('never routes into a room the person only reads', async () => {
    // A viewer cannot write, so the router must not consider the room at all — otherwise
    // automatic placement becomes a way to attempt a write that would be refused.
    const owner = await harness.registerPerson(`agare-${randomUUID()}@example.com`, 'Anna');
    const ownerActor = harness.actorFor(owner.person, 'web');
    const room = await harness.services.rooms.create(ownerActor, { title: 'Styrelsen' });

    const reader = await harness.personByEmail(email);
    const { url } = await harness.services.invites.create(ownerActor, {
      roomId: room.id,
      channel: 'email',
      destination: email,
      role: 'viewer',
    });
    await harness.services.invites.accept(harness.tokenFromUrl(url), reader.id);

    const readerActor = harness.actorFor(reader, 'claude-desktop');
    const decision = await harness.services.ingest.remember(readerActor, {
      body: 'Styrelsen sammanträder i juni',
    });

    expect(decision.routing.placement).toBe('private');
    expect(
      decision.routing.considered.map((candidate: { title: string }) => candidate.title),
    ).not.toContain('Styrelsen');
  });
});

describe('what the trash promises', () => {
  const email = `radering-${randomUUID()}@example.com`;

  it('erases the quotation a correction kept, not just the memory', async () => {
    // A correction records what it replaced, on the *new* memory's event. Purging the old
    // one therefore has to reach an event that is not about it, or the trash kept half a
    // promise: the row is gone and the sentence is still in an append-only payload.
    const person = await harness.registerPerson(email, 'Emil');
    const actor = harness.actorFor(person.person, 'claude-desktop');
    const room = await harness.services.identity.personalRoomOf(actor.personId);

    const first = await harness.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Bor på Hornsgatan 1 i Stockholm',
      kind: 'identity',
    });

    // Contradicts the above, so it queues, and approving it supersedes the original.
    const queued = await harness.services.ingest.remember(actor, {
      roomId: room.id,
      body: 'Bor inte på Hornsgatan 1 i Stockholm',
      kind: 'identity',
    });
    expect(queued.outcome).toBe('needs_approval');
    await harness.services.ingest.resolveProposal(actor, queued.proposal.id, true);

    await harness.services.trash.purgeNow(actor, first.item.shortId).catch(async () => {
      // Superseded rather than deleted: put it in the trash first, which is the path a
      // person would take to remove an old value for good.
      await harness.services.ingest.forget(actor, first.item.shortId, room.id);
      await harness.expireTrash(first.item.shortId);
      expect(await harness.services.trash.purgeExpired()).toBeGreaterThan(0);
    });

    expect(await harness.textExistsAnywhere('Bor på Hornsgatan 1 i Stockholm')).toBe(false);
  });
});

/**
 * The invariant every test above depends on without saying so.
 *
 * Placed last on purpose: by the time it runs, this file has driven saves, approvals,
 * corrections, deletions, restores, moves, shares and disputes through whichever backend is
 * selected. Rebuilding each memory and each document from `app.event` and comparing it to the
 * projection is therefore one assertion over all of it — and it is the check that gives
 * `AGENTS.md`'s claim that the tables are projections something behind it.
 */
describe('the log and the projections agree', () => {
  it('has nothing to report after everything above', async () => {
    expect(await harness.divergences()).toEqual([]);
  });
});
