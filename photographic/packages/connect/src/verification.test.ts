import { describe, expect, it } from 'vitest';

import type { Actor, PersonId } from '@photographic/core';

import { buildClients, findClient } from './clients.js';
import { createHarness, MemorySessions } from './testing/index.js';
import { isDegraded, pollVerification, startVerification } from './verification.js';

const CONFIG = {
  mcpUrl: 'https://photographic.me/mcp',
  connectPageUrl: 'https://photographic.me/connect',
};
const CLIENTS = buildClients(CONFIG);

function actorFor(personId: string): Actor {
  return {
    personId: personId as PersonId,
    agentClient: 'web',
    sessionId: null,
    roomScope: [],
  };
}

function setup() {
  const h = createHarness();
  const sessions = h.sessions as MemorySessions;
  const deps = { sessions, clock: h.deps.clock };
  return { h, sessions, deps, actor: actorFor('person-1') };
}

describe('verification', () => {
  it('waits, and tells the person exactly what to say', async () => {
    const { h, deps, actor } = setup();
    const claude = findClient(CLIENTS, 'claude');

    const handle = await startVerification(deps, actor, claude);
    h.setNow(new Date(h.now().getTime() + 2000));

    const state = await pollVerification(deps, actor, handle, claude);
    expect(state.status).toBe('waiting');
    if (state.status === 'waiting') {
      expect(state.prompt).toBe('Vad vet du om mig?');
      expect(state.elapsedMs).toBe(2000);
      expect(state.remainingMs).toBeGreaterThan(0);
    }
  });

  it('resolves on the first delivery and reports how context arrived', async () => {
    const { h, sessions, deps, actor } = setup();
    const claude = findClient(CLIENTS, 'claude');

    const handle = await startVerification(deps, actor, claude);

    h.setNow(new Date(h.now().getTime() + 5000));
    await sessions.simulateDelivery({
      personId: actor.personId,
      agentClient: 'claude-desktop',
      method: 'mcp_instructions',
      at: h.now(),
    });

    const state = await pollVerification(deps, actor, handle, claude);
    expect(state.status).toBe('connected');
    if (state.status === 'connected') {
      expect(state.agentClient).toBe('claude-desktop');
      expect(state.deliveryMethod).toBe('mcp_instructions');
      expect(state.degraded).toBe(false);
    }
  });

  it('accepts the mobile app as the same client', async () => {
    const { h, sessions, deps, actor } = setup();
    const claude = findClient(CLIENTS, 'claude');
    const handle = await startVerification(deps, actor, claude);

    h.setNow(new Date(h.now().getTime() + 1000));
    await sessions.simulateDelivery({
      personId: actor.personId,
      agentClient: 'claude-mobile',
      method: 'mcp_instructions',
      at: h.now(),
    });

    const state = await pollVerification(deps, actor, handle, claude);
    expect(state.status).toBe('connected');
  });

  it('ignores a different client connecting', async () => {
    const { h, sessions, deps, actor } = setup();
    const claude = findClient(CLIENTS, 'claude');
    const handle = await startVerification(deps, actor, claude);

    h.setNow(new Date(h.now().getTime() + 1000));
    await sessions.simulateDelivery({
      personId: actor.personId,
      agentClient: 'cursor',
      method: 'mcp_instructions',
      at: h.now(),
    });

    expect((await pollVerification(deps, actor, handle, claude)).status).toBe('waiting');
  });

  it('does not count a delivery that happened before we started waiting', async () => {
    const { h, sessions, deps, actor } = setup();
    const claude = findClient(CLIENTS, 'claude');

    // Claude worked last week. Reconnecting must not light up green instantly.
    await sessions.simulateDelivery({
      personId: actor.personId,
      agentClient: 'claude-desktop',
      method: 'mcp_instructions',
      at: new Date(h.now().getTime() - 7 * 24 * 60 * 60 * 1000),
    });

    const handle = await startVerification(deps, actor, claude);
    h.setNow(new Date(h.now().getTime() + 3000));

    expect((await pollVerification(deps, actor, handle, claude)).status).toBe('waiting');
  });

  it('flags a connection that only arrived by a weaker route', async () => {
    const { h, sessions, deps, actor } = setup();
    const claude = findClient(CLIENTS, 'claude');
    const handle = await startVerification(deps, actor, claude);

    h.setNow(new Date(h.now().getTime() + 1000));
    await sessions.simulateDelivery({
      personId: actor.personId,
      agentClient: 'claude-desktop',
      method: 'tool_call',
      at: h.now(),
    });

    const state = await pollVerification(deps, actor, handle, claude);
    expect(state.status).toBe('connected');
    if (state.status === 'connected') expect(state.degraded).toBe(true);
  });

  it('times out with a remedy specific to the client', async () => {
    const { h, deps, actor } = setup();

    const claude = findClient(CLIENTS, 'claude');
    const claudeHandle = await startVerification(deps, actor, claude);
    h.setNow(new Date(h.now().getTime() + 120_000));
    const claudeState = await pollVerification(deps, actor, claudeHandle, claude);
    expect(claudeState.status).toBe('timed_out');
    if (claudeState.status === 'timed_out') {
      expect(claudeState.remedy).toMatch(/web eller desktop/i);
    }

    const chatgpt = findClient(CLIENTS, 'chatgpt');
    const chatgptHandle = await startVerification(deps, actor, chatgpt);
    h.setNow(new Date(h.now().getTime() + 120_000));
    const chatgptState = await pollVerification(deps, actor, chatgptHandle, chatgpt);
    expect(chatgptState.status).toBe('timed_out');
    if (chatgptState.status === 'timed_out') {
      expect(chatgptState.remedy).toMatch(/Developer mode/i);
    }
  });

  it('never reports success from configuration alone', async () => {
    const { sessions, deps, actor } = setup();
    const cursor = findClient(CLIENTS, 'cursor');
    const handle = await startVerification(deps, actor, cursor);

    // A session that started but never received the profile is not a success.
    await sessions.start({
      personId: actor.personId,
      agentClient: 'cursor',
      transport: 'mcp',
    });

    expect((await pollVerification(deps, actor, handle, cursor)).status).toBe('waiting');
  });

  it('does not see another person\u2019s deliveries', async () => {
    const { h, sessions, deps, actor } = setup();
    const claude = findClient(CLIENTS, 'claude');
    const handle = await startVerification(deps, actor, claude);

    h.setNow(new Date(h.now().getTime() + 1000));
    await sessions.simulateDelivery({
      personId: 'person-2' as PersonId,
      agentClient: 'claude-desktop',
      method: 'mcp_instructions',
      at: h.now(),
    });

    expect((await pollVerification(deps, actor, handle, claude)).status).toBe('waiting');
  });
});

describe('degradation ranking', () => {
  it('treats a missing method as degraded', () => {
    expect(isDegraded('mcp_instructions', null)).toBe(true);
  });

  it('is not degraded when delivery beat expectations', () => {
    expect(isDegraded('tool_call', 'system_prompt')).toBe(false);
    expect(isDegraded('mcp_instructions', 'mcp_instructions')).toBe(false);
  });

  it('is degraded when the model had to ask for it', () => {
    expect(isDegraded('hook', 'tool_call')).toBe(true);
  });
});
