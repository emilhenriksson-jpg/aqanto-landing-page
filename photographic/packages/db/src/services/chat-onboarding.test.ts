import { randomUUID } from 'node:crypto';
import type { Actor, ContextCandidate, Proposal } from '@photographic/core';
import { proposalReviewKey } from '@photographic/core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, createPostgresServices, migrate, type PostgresServices } from '../index.js';
import { failOnce } from '../testing/fail-once.js';

const pool = createPool();
let wired: PostgresServices;
beforeAll(async () => { await migrate(pool); wired = await createPostgresServices({ pool }); });
afterAll(async () => { await pool.end(); });

async function person(): Promise<Actor> {
  const { person } = await wired.services.identity.register({ email: `${randomUUID()}@chat-onboarding.test` });
  return wired.actorFor(person.id, 'chatgpt-web');
}
const candidate = (text: string, extra: Partial<ContextCandidate> = {}): ContextCandidate => ({ text,
  kind: 'fact', origin: 'client_memory', sourceLabel: 'Den här chatten', evidence: 'reported',
  sensitive: false, concernsOthers: false, ...extra });
const consent = async (proposal: Proposal) => ({ privateOnly: true, reviewed: true,
  reviewKey: await proposalReviewKey(proposal), confirmation: 'Kör, spara och skapa rummen.' });

it('creates one private room under concurrent retries and records its creation once', async () => {
  const actor = await person();
  const rooms = await Promise.all(Array.from({ length: 3 }, () => wired.services.rooms.create(actor,
    { title: 'Atlas', description: 'Karttjänstens projekt', reusePrivate: true })));
  expect(new Set(rooms.map(r => r.id)).size).toBe(1);
  const { rows } = await pool.query(`SELECT * FROM app.event WHERE room_id = $1 AND event_type = 'room.created'`, [rooms[0]!.id]);
  expect(rows).toHaveLength(1);
  expect((await wired.services.rooms.listForPerson(actor)).find(r => r.title === 'Atlas')?.memberCount).toBe(1);
});

it('approves a combined private room and memory once, preserving source and chat confirmation', async () => {
  const actor = await person();
  const batch = await wired.services.ingest.prepareContributions(actor, { batchId: randomUUID(), candidates: [
    candidate('Atlas är mitt kartprojekt.', { roomTitle: 'Atlas' }),
  ] });
  const proposal = batch.proposals[0]!;
  expect(await wired.services.rooms.listForPerson(actor)).toHaveLength(1);
  const answer = await consent(proposal);
  const items = await Promise.all(Array.from({ length: 2 }, () => wired.services.ingest.resolveProposal(actor, proposal.id, true, answer)));
  expect(items[0]!.id).toBe(items[1]!.id);
  const project = (await wired.services.rooms.listForPerson(actor)).find(r => r.title === 'Atlas')!;
  expect(items[0]!.roomId).toBe(project.roomId);
  expect(await wired.services.retrieval.listForRoom(actor, project.roomId)).toHaveLength(1);
  const { rows } = await pool.query(`SELECT payload FROM app.event WHERE actor_person_id = $1 AND event_type = 'proposal.accepted'`, [actor.personId]);
  expect(rows).toHaveLength(1);
  expect(rows[0].payload.approval_channel).toBe('chat');
});

it('rolls the new room and the approval back if the memory insert fails, then permits retry', async () => {
  const actor = await person();
  const batch = await wired.services.ingest.prepareContributions(actor, { batchId: randomUUID(), candidates: [
    candidate('Atlas lanseras i november.', { roomTitle: 'Atlas' }),
  ] });
  const proposal = batch.proposals[0]!;
  const answer = await consent(proposal);
  const failure = failOnce(pool, /INSERT INTO app\.item /);
  const failing = await createPostgresServices({ pool: failure.pool });
  await expect(failing.services.ingest.resolveProposal(actor, proposal.id, true, answer)).rejects.toThrow('injected failure');
  expect(failure.fired()).toBe(true);
  expect(await wired.services.rooms.listForPerson(actor)).toHaveLength(1);
  expect(await wired.services.ingest.listProposals(actor)).toHaveLength(1);
  await wired.services.ingest.resolveProposal(actor, proposal.id, true, answer);
  expect(await wired.services.rooms.listForPerson(actor)).toHaveLength(2);
});

it('refuses stale previews and rooms that acquired another member without changing the proposal', async () => {
  const actor = await person();
  const other = await person();
  const project = await wired.services.rooms.create(actor, { title: 'Atlas' });
  const batch = await wired.services.ingest.prepareContributions(actor, { batchId: randomUUID(), candidates: [
    candidate('Atlas hanterar kartor.', { roomTitle: 'Atlas' }),
  ] });
  const proposal = batch.proposals[0]!;
  const answer = await consent(proposal);
  await expect(wired.services.ingest.resolveProposal(actor, proposal.id, true, { ...answer, reviewKey: '0'.repeat(64) })).rejects.toThrow('Underlaget');
  await pool.query(`INSERT INTO app.membership (person_id, room_id, role) VALUES ($1, $2, 'editor')`, [other.personId, project.id]);
  await expect(wired.services.ingest.resolveProposal(actor, proposal.id, true, answer)).rejects.toThrow('delas med andra');
  expect(await wired.services.retrieval.listForRoom(actor, project.id)).toHaveLength(0);
  expect(await wired.services.ingest.listProposals(actor)).toHaveLength(1);
  await expect(wired.services.ingest.resolveProposal(other, proposal.id, true, answer)).rejects.toThrow('Förslaget finns inte');
  const personal = await wired.services.identity.personalRoomOf(actor.personId);
  await expect(wired.services.rooms.create({ ...actor, roomScope: [personal.id] }, { title: 'Nytt', reusePrivate: true })).rejects.toThrow('rumsbegränsad');
});
