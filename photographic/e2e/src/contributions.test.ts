import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dispatchTool } from '@photographic/mcp';
import type { ContextCandidate } from '@photographic/core';
import { createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => { h = await createHarness({ databaseUrl: process.env.DATABASE_URL ?? 'postgres://photographic:photographic@127.0.0.1:5432/photographic' }); });
afterAll(async () => { await h?.teardown(); });
const candidate = (text: string, extra: Partial<ContextCandidate> = {}): ContextCandidate => ({ text, kind: 'fact', origin: 'client_memory', sourceLabel: 'Tillgängligt minne i ChatGPT', evidence: 'reported', sensitive: false, concernsOthers: false, ...extra });
async function person() {
  const registered = await h.registerPerson(`contribution-${randomUUID()}@example.com`, 'Test');
  const ai = h.actorFor(registered.person, 'chatgpt-web');
  const human = h.actorFor(registered.person, 'web');
  return { ...registered, ai, human };
}

it('prepares all new context as one private review and carries it to another AI with original provenance', async () => {
  const { ai, human, personalRoom } = await person();
  await h.services.ingest.remember(ai, { roomId: personalRoom.id, body: 'Jag bor i Göteborg', explicit: true });
  const batchId = randomUUID();
  const preview = await h.services.ingest.prepareContributions(ai, { batchId, candidates: [
    candidate('Jag bor i Göteborg'), candidate('Jag bygger en segelbåt'),
    candidate('Jag är allergisk mot jordnötter', { sensitive: true }),
    candidate('Jag verkar föredra små grupper', { evidence: 'inferred' }),
    candidate('Återberättat från Photographic', { origin: 'photographic' }),
    candidate('api_key: sk-abcdefgh123456'),
  ] });
  expect(preview.proposals).toHaveLength(3);
  expect(preview.skipped.map(x => x.reason)).toEqual(['known', 'photographic', 'secret']);
  const claude = { ...ai, agentClient: 'claude-desktop' as const };
  expect((await dispatchTool({ services: h.services }, claude, 'get_context', {})).text).not.toContain('bygger en segelbåt');
  const results = await h.services.ingest.resolveContributions(human, { ids: preview.proposals.map(p => p.id), reviewedIds: [], accept: true });
  expect(results.map(x => x.status)).toEqual(['saved', 'needs_review', 'needs_review']);
  await h.runJobsToCompletion();
  expect((await dispatchTool({ services: h.services }, claude, 'get_context', {})).text).toContain('bygger en segelbåt');
  const shortId = results[0]!.shortId!;
  const source = await h.services.history.provenance(human, shortId as never, personalRoom.id);
  expect(source?.savedByClient).toBe('chatgpt-web');
  const remaining = preview.proposals.slice(1);
  const accepted = await h.services.ingest.resolveContributions(human, { ids: remaining.map(p => p.id), reviewedIds: remaining.map(p => p.id), accept: true });
  expect(accepted.every(x => x.status === 'saved')).toBe(true);
  const repeat = await h.services.ingest.prepareContributions(claude, { batchId: randomUUID(), candidates: [candidate('Jag bygger en segelbåt')] });
  expect(repeat.proposals).toHaveLength(0);
});

it('keeps a decline across clients, supports explicit resume, and suppresses rejected offers', async () => {
  const { ai, human } = await person();
  const c = candidate('Jag övar på portugisiska varje kväll');
  const p = await h.services.ingest.prepareContributions(ai, { batchId: randomUUID(), candidates: [c] });
  await h.services.ingest.resolveContributions(human, { ids: p.proposals.map(x => x.id), reviewedIds: [], accept: false });
  const claude = { ...ai, agentClient: 'claude-desktop' as const };
  expect((await h.services.ingest.contributionState(claude)).paused).toBe(true);
  expect((await h.services.ingest.prepareContributions(claude, { batchId: randomUUID(), candidates: [c] })).paused).toBe(true);
  await h.services.ingest.pauseContributions(human, false);
  const repeat = await h.services.ingest.prepareContributions(claude, { batchId: randomUUID(), candidates: [c] });
  expect(repeat.proposals).toHaveLength(0);
  expect(repeat.skipped[0]?.reason).toBe('already_offered');
});

it('handles retried chunks and concurrent approvals without duplicate writes', async () => {
  const { ai, human } = await person();
  const input = { batchId: randomUUID(), candidates: [candidate('Min favoritfrukt är passionsfrukt')] };
  const [a, b] = await Promise.all([h.services.ingest.prepareContributions(ai, input), h.services.ingest.prepareContributions(ai, input)]);
  expect(a.proposals[0]?.id).toBe(b.proposals[0]?.id);
  const accept = () => h.services.ingest.resolveContributions(human, { ids: [a.proposals[0]!.id], reviewedIds: [], accept: true });
  await Promise.all([accept(), accept()]);
  const history = await h.services.history.list(human, {});
  expect(history.filter(entry => entry.body === input.candidates[0]!.text && entry.action === 'saved')).toHaveLength(1);
});

it('refreshes a stale offer instead of treating the newest claim as truth', async () => {
  const { ai, human, personalRoom } = await person();
  const p = await h.services.ingest.prepareContributions(ai, { batchId: randomUUID(), candidates: [candidate('Jag arbetar på kontoret varje måndag')] });
  await h.services.ingest.remember(human, { roomId: personalRoom.id, body: 'Jag arbetar inte på kontoret varje måndag', explicit: true });
  const result = await h.services.ingest.resolveContributions(human, { ids: [p.proposals[0]!.id], reviewedIds: [], accept: true });
  expect(result[0]?.status).toBe('needs_review');
  const pending = await h.services.ingest.listProposals(human);
  expect(pending.find(x => x.id === p.proposals[0]!.id)?.reason).toContain('Skiljer sig');
});

it('does not cross account or room scope boundaries', async () => {
  const a = await person(); const b = await person();
  const p = await h.services.ingest.prepareContributions(a.ai, { batchId: randomUUID(), candidates: [candidate('Mitt hemliga projekt heter Solros')] });
  await expect(h.services.ingest.resolveContributions(b.human, { ids: [p.proposals[0]!.id], reviewedIds: [], accept: true })).rejects.toThrow();
  const scoped = { ...a.ai, roomScope: [b.personalRoom.id] };
  await expect(h.services.ingest.prepareContributions(scoped, { batchId: randomUUID(), candidates: [candidate('Otillåten information')] })).rejects.toThrow();
  expect((await h.services.ingest.contributionState(scoped)).paused).toBe(true);
});

it('suppresses a paraphrase from the next client and does not reimport a deliberately deleted contribution', async () => {
  const { ai, human, personalRoom } = await person();
  const preview = await h.services.ingest.prepareContributions(ai, { batchId: randomUUID(), candidates: [candidate('Jag seglar längs Sveriges västkust varje sommar')] });
  const saved = await h.services.ingest.resolveContributions(human, { ids: preview.proposals.map(p => p.id), reviewedIds: [], accept: true });
  const repeat = await h.services.ingest.prepareContributions(ai, { batchId: randomUUID(), candidates: [candidate('Varje sommar seglar jag längs Sveriges västkust')] });
  expect(repeat.proposals).toHaveLength(0);
  expect(repeat.skipped[0]?.reason).toBe('known');
  await h.services.ingest.forget(human, saved[0]!.shortId! as never, personalRoom.id);
  const afterDelete = await h.services.ingest.prepareContributions(ai, { batchId: randomUUID(), candidates: [candidate('Varje sommar seglar jag längs Sveriges västkust')] });
  expect(afterDelete.proposals).toHaveLength(0);
  expect(afterDelete.skipped[0]?.reason).toBe('already_offered');
});

it('requires the displayed review again when another tab already refreshed a contradiction', async () => {
  const { ai, human, personalRoom } = await person();
  const p = await h.services.ingest.prepareContributions(ai, { batchId: randomUUID(), candidates: [candidate('Jag arbetar på kontoret varje tisdag')] });
  const proposal = p.proposals[0]!;
  const expectedReasons = { [proposal.id]: proposal.reason };
  await h.services.ingest.remember(human, { roomId: personalRoom.id, body: 'Jag arbetar inte på kontoret varje tisdag', explicit: true });
  await h.services.ingest.resolveContributions(human, { ids: [proposal.id], reviewedIds: [], expectedReasons, accept: true });
  // Another tab still submits the earlier snapshot, including a checked review box.
  const stale = await h.services.ingest.resolveContributions(human, { ids: [proposal.id], reviewedIds: [proposal.id], expectedReasons, accept: true });
  expect(stale[0]?.status).toBe('needs_review');
  const fresh = (await h.services.ingest.listProposals(human)).find(p => p.id === proposal.id)!;
  const accepted = await h.services.ingest.resolveContributions(human, { ids: [proposal.id], reviewedIds: [proposal.id], expectedReasons: { [proposal.id]: fresh.reason }, accept: true });
  expect(accepted[0]?.status).toBe('saved');
});
