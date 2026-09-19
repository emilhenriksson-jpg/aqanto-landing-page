import { expect, it, vi } from 'vitest';
import { FakeLlm } from '@photographic/core/testing';
import type { Actor, ContextCandidate } from '@photographic/core';
import { createMemoryServices } from './index.js';

it('keeps a whole chunk pending for retry when comparison fails halfway through', async () => {
  const llm = new FakeLlm();
  const { services } = createMemoryServices({ baseUrl: 'https://test.invalid', llm });
  const { person, personalRoom } = await services.identity.register({ email: 'retry@example.com' });
  const actor: Actor = { personId: person.id, agentClient: 'chatgpt-web', sessionId: null, roomScope: [] };
  await services.ingest.remember(actor, { roomId: personalRoom.id, body: 'Jag seglar varje sommar', explicit: true });
  const input = { batchId: 'retry-batch', candidates: ['Jag skriver en roman', 'Jag bygger en bokhylla'].map(text => ({
    text, kind: 'fact', origin: 'conversation', sourceLabel: 'Denna chatt', evidence: 'reported', sensitive: false, concernsOthers: false,
  } satisfies ContextCandidate)) };
  const compare = vi.spyOn(llm, 'compare').mockResolvedValueOnce('unrelated').mockRejectedValueOnce(new Error('Provider unavailable'));
  await expect(services.ingest.prepareContributions(actor, input)).rejects.toThrow('Provider unavailable');
  expect(await services.ingest.listProposals(actor)).toEqual([]);
  compare.mockRestore();
  const retried = await services.ingest.prepareContributions(actor, input);
  expect(retried.proposals).toHaveLength(2);
  const embed = vi.spyOn(llm, 'embed').mockResolvedValue([]);
  const result = await services.ingest.resolveContributions(actor, { ids: retried.proposals.map(p => p.id), reviewedIds: [], accept: true });
  expect(result.every(entry => entry.status === 'failed')).toBe(true);
  expect(await services.ingest.listProposals(actor)).toHaveLength(2);
  embed.mockRestore();
  const accepted = await services.ingest.resolveContributions(actor, { ids: retried.proposals.map(p => p.id), reviewedIds: [], accept: true });
  expect(accepted.every(entry => entry.status === 'saved')).toBe(true);
});
