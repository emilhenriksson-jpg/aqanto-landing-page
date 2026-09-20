import { randomUUID } from 'node:crypto';
import type { Actor, ContextCandidate } from '@photographic/core';
import { proposalReviewKey } from '@photographic/core';
import { createMemoryServices } from '@photographic/services-memory';
import { beforeEach, expect, it } from 'vitest';
import { dispatchTool } from './dispatch.js';

let wired: ReturnType<typeof createMemoryServices>;
let actor: Actor;
const candidate = (text: string, extra: Partial<ContextCandidate> = {}): ContextCandidate => ({ text,
  kind: 'fact', origin: 'client_memory', sourceLabel: 'Tillgänglig chattkontext', evidence: 'reported',
  sensitive: false, concernsOthers: false, ...extra });
const call = (name: string, args: unknown = {}, as = actor) => dispatchTool({ services: wired.services }, as, name, args);

beforeEach(async () => {
  wired = createMemoryServices();
  const { person } = await wired.services.identity.register({ email: `${randomUUID()}@onboarding.test`, displayName: 'Nora' });
  actor = wired.actorFor(person.id, 'chatgpt-web');
});

async function decisions(reviewed = false) {
  return Promise.all((await wired.services.ingest.listProposals(actor)).map(async p => ({
    id: p.id, review_key: await proposalReviewKey(p), reviewed,
  })));
}

it('prepares memories and rooms, then completes everything in chat without a website', async () => {
  const context = await call('get_context');
  expect(context.text).toContain('Första underlaget');
  const batch_id = randomUUID();
  const prepared = await call('prepare_context', { action: 'prepare', batch_id, candidates: [
    candidate('Jag bor i Uppsala.'), candidate('Jag arbetar med karttjänsten Atlas.', { roomTitle: 'Atlas', roomDescription: 'Karttjänstens beslut och planer.' }),
    candidate('Atlas ska lanseras i november.', { kind: 'decision', roomTitle: 'Atlas' }),
  ] });
  expect(prepared.isError).toBe(false);
  expect(prepared.text).toContain('review_proposals');
  expect(await wired.services.rooms.listForPerson(actor)).toHaveLength(1);
  expect((await call('get_context')).text).not.toContain('Jag bor i Uppsala');
  expect((await call('get_context')).text).toContain('3 väntar');
  const preview = await call('review_proposals', { action: 'list' });
  expect(preview.text).toContain('Karttjänstens beslut');
  const answer = { action: 'approve', confirmation: 'Kör, spara förslaget och skapa Atlas.', decisions: await decisions() };
  const result = await call('review_proposals', answer);
  expect(result.text.match(/"status":"saved"/g)).toHaveLength(3);
  const rooms = await wired.services.rooms.listForPerson(actor);
  expect(rooms).toHaveLength(2);
  const project = rooms.find(room => room.title === 'Atlas')!;
  expect(project.memberCount).toBe(1);
  expect(await wired.services.retrieval.listForRoom(actor, project.roomId)).toHaveLength(2);
  const again = await Promise.all([call('review_proposals', answer), call('review_proposals', answer)]);
  expect(again.every(r => !r.isError && !r.text.includes('"status":"not_applied"'))).toBe(true);
  expect(await wired.services.retrieval.listForRoom(actor, project.roomId)).toHaveLength(2);
  const events = wired.store.allEvents().filter(event => event.eventType === 'proposal.accepted');
  expect(events).toHaveLength(3);
  expect(events.every(event => event.payload['approval_channel'] === 'chat')).toBe(true);
  expect((await call('get_context', { room: 'Atlas' })).text).toContain('Atlas');
});

it('creates or reuses an explicitly requested private room and refuses room-scoped creation', async () => {
  await Promise.all([call('create_room', { title: 'Atlas' }), call('create_room', { title: '  Atlas  ' })]);
  const rooms = await wired.services.rooms.listForPerson(actor);
  expect(rooms.filter(room => room.title === 'Atlas')).toHaveLength(1);
  const scoped = { ...actor, roomScope: [rooms[0]!.roomId] };
  expect((await call('create_room', { title: 'Annat' }, scoped)).isError).toBe(true);
  expect((await call('create_room', { title: 'api key: sk-secret-value' })).isError).toBe(true);
});

it('requires an answer, rejects stale previews and keeps sensitive details pending without review', async () => {
  await call('prepare_context', { action: 'prepare', batch_id: randomUUID(), candidates: [candidate('Jag har migrän.', { sensitive: true })] });
  const selected = await decisions();
  expect((await call('review_proposals', { action: 'approve', decisions: selected })).isError).toBe(true);
  expect((await call('review_proposals', { action: 'approve', confirmation: 'Kör', decisions: selected })).text).toContain('"status":"not_applied"');
  const proposal = (await wired.services.ingest.listProposals(actor))[0]!;
  proposal.body = 'Jag har en annan diagnos.';
  expect((await call('review_proposals', { action: 'approve', confirmation: 'Ja', decisions: selected.map(p => ({ ...p, reviewed: true })) })).text).toContain('"status":"not_applied"');
  expect((await wired.services.ingest.listProposals(actor))).toHaveLength(1);
});

it('does not approve an audience change, another person’s proposal or a room that became shared', async () => {
  await call('prepare_context', { action: 'prepare', batch_id: randomUUID(), candidates: [candidate('Atlas bygger kartor.', { roomTitle: 'Atlas' })] });
  const selected = await decisions();
  const project = await wired.services.rooms.create(actor, { title: 'Atlas' });
  const { person: other } = await wired.services.identity.register({ email: `${randomUUID()}@onboarding.test` });
  wired.store.addMembership({ personId: other.id, roomId: project.id, role: 'editor' });
  const result = await call('review_proposals', { action: 'approve', confirmation: 'Spara förslaget', decisions: selected });
  expect(result.text).toContain('"status":"not_applied"');
  expect(await wired.services.retrieval.listForRoom(actor, project.id)).toHaveLength(0);
  expect(await wired.services.rooms.listForPerson(actor)).toHaveLength(2);
  const foreign = await call('review_proposals', { action: 'approve', confirmation: 'Ja', decisions: selected }, wired.actorFor(other.id));
  expect(foreign.text).toContain('"status":"not_applied"');
});

it('pauses and resumes contributions in the chat and never repeats pending offers', async () => {
  await call('prepare_context', { action: 'pause' });
  expect((await call('get_context')).text).toContain('pausade — erbjud inte igen');
  await call('review_proposals', { action: 'resume' });
  await call('prepare_context', { action: 'prepare', batch_id: randomUUID(), candidates: [candidate('Jag gillar korta svar.')] });
  expect((await call('get_context')).text).toContain('1 väntar — påminn inte igen');
  const result = await call('review_proposals', { action: 'reject', confirmation: 'Ta bort det förslaget', decisions: await decisions() });
  expect(result.text).toContain('dismissed');
  expect(await wired.services.ingest.listProposals(actor)).toHaveLength(0);
});
