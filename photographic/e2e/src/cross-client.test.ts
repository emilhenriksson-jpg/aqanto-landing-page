/** The same tool path, memory and permissions, across distinct AI sessions.
 * Both memory and PostgreSQL CI run this. Client/model UIs are not simulated here. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dispatchTool } from '@photographic/mcp';
import { createHarness, type Harness } from './harness.js';
import type { Actor } from '@photographic/core';

let harness: Harness;
beforeAll(async () => { harness = await createHarness({ databaseUrl: process.env.DATABASE_URL ?? 'postgres://photographic:photographic@127.0.0.1:5432/photographic' }); });
afterAll(async () => { await harness?.teardown(); });

it('continues a Claude decision in ChatGPT without choosing a room, then retrieves detail', async () => {
  const { person } = await harness.registerPerson(`continuity-${randomUUID()}@example.com`, 'Emil');
  async function actor(agentClient: Actor['agentClient']): Promise<Actor> {
    const session = await harness.services.sessions.start({ personId: person.id, agentClient, transport: 'mcp' });
    return { ...harness.actorFor(person, agentClient), sessionId: session.id };
  }
  const claude = await actor('claude-desktop');
  const chatgpt = await actor('chatgpt-web');
  const call = (who: Actor, name: string, args: unknown = {}) => dispatchTool({ services: harness.services }, who, name, args);

  // ChatGPT's connection existed before Claude wrote: reusing it must not cache context.
  const before = await call(chatgpt, 'get_context');
  expect(before.isError).not.toBe(true);
  expect(before.text).not.toContain('Lanseringen blir i november');
  const saved = await call(claude, 'remember', { text: 'Lanseringen blir i november', kind: 'fact' });
  expect(saved.isError).not.toBe(true);
  await harness.runJobsToCompletion();
  const fresh = await call(chatgpt, 'get_context');
  expect(fresh.text).toContain('Lanseringen blir i november');
  expect(fresh.text).toContain('Var ni var senast');
  const history = await harness.services.history.list(chatgpt, {});
  expect(history.some((entry) => entry.body?.includes('Lanseringen blir i november') && entry.agentClient === 'claude-desktop')).toBe(true);

  const room = await harness.services.rooms.create(claude, { title: 'Lansering' });
  const proposal = await harness.services.ingest.remember(claude, { roomId: room.id, body: 'Vi väljer november för att hinna testa med kunder.', kind: 'decision', explicit: true });
  expect(proposal.outcome).toBe('needs_approval');
  if (proposal.outcome !== 'needs_approval') throw new Error('Shared write bypassed approval');
  expect((await call(chatgpt, 'get_context', { room: 'Lansering' })).text).not.toContain('hinna testa med kunder');
  await harness.services.ingest.resolveProposal(claude, proposal.proposal.id, true);
  await harness.runJobsToCompletion();
  expect((await call(chatgpt, 'get_context')).text).toContain('Lansering');
  expect((await call(chatgpt, 'get_context', { room: 'Lansering' })).text).toContain('hinna testa med kunder');

  const stranger = await harness.registerPerson(`stranger-${randomUUID()}@example.com`, 'Annan');
  const strangerActor = harness.actorFor(stranger.person, 'cursor');
  expect((await call(strangerActor, 'get_context')).text).not.toContain('Lanseringen blir i november');
  expect((await call(strangerActor, 'get_context', { room: room.id })).isError).toBe(true);
  const health = await harness.services.sessions.health(chatgpt);
  expect(health.find((entry) => entry.agentClient === 'chatgpt-web')?.deliveryMethod).toBe('tool_call');
});
