import { describe, expect, it } from 'vitest';

import type { Actor, PersonId } from '@photographic/core';

import {
  handleConnect,
  handleSignupRequest,
  handleSignupVerify,
  handleStartVerification,
  handleVerificationStatus,
} from './routes.js';
import type { ConnectPayload } from './routes.js';
import { createHarness } from './testing/index.js';
import type { VerificationHandle } from './verification.js';

const CONFIG = {
  mcpUrl: 'https://photographic.me/mcp',
  connectPageUrl: 'https://photographic.me/connect',
};

const ACTOR: Actor = {
  personId: 'person-1' as PersonId,
  agentClient: 'web',
  sessionId: null,
  roomScope: [],
};

describe('signup routes', () => {
  it('walks request through verify and lands on connect', async () => {
    const h = createHarness({ fixedCode: '424242' });

    const requested = await handleSignupRequest(h.deps, { body: { email: 'emil@example.com' } });
    expect(requested.status).toBe(200);
    const requestId = (requested.body as { requestId: string }).requestId;

    const verified = await handleSignupVerify(h.deps, { body: { requestId, code: '424242' } });
    expect(verified.status).toBe(200);
    const body = verified.body as { next: string; created: boolean; session: { token: string } };
    expect(body.next).toBe('connect');
    expect(body.created).toBe(true);
    expect(body.session.token).toBeTruthy();
  });

  it('maps a bad code to 401 rather than throwing', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const requested = await handleSignupRequest(h.deps, { body: { email: 'emil@example.com' } });
    const requestId = (requested.body as { requestId: string }).requestId;

    const verified = await handleSignupVerify(h.deps, { body: { requestId, code: '000000' } });
    expect(verified.status).toBe(401);
    expect(verified.body).toMatchObject({ error: 'unauthorized' });
  });

  it('maps a malformed email to 400', async () => {
    const h = createHarness();
    const result = await handleSignupRequest(h.deps, { body: { email: 'nope' } });
    expect(result.status).toBe(400);
  });

  it('requires both fields on verify', async () => {
    const h = createHarness();
    expect((await handleSignupVerify(h.deps, { body: {} })).status).toBe(400);
  });

  it('tolerates a missing or non-object body', async () => {
    const h = createHarness();
    expect((await handleSignupRequest(h.deps, {})).status).toBe(400);
    expect((await handleSignupRequest(h.deps, { body: 'nonsense' })).status).toBe(400);
  });
});

describe('the connect payload', () => {
  it('returns every client, a QR code and the shared URL', async () => {
    const result = await handleConnect(CONFIG, { headers: { 'user-agent': 'Cursor/3.15' } });
    expect(result.status).toBe(200);

    const payload = result.body as ConnectPayload;
    expect(payload.mcpUrl).toBe(CONFIG.mcpUrl);
    expect(payload.clients).toHaveLength(6);
    expect(payload.clients[0]?.id).toBe('cursor');
    expect(payload.detected.likelyClient).toBe('cursor');
    expect(payload.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(payload.headline).toMatch(/Samma adress/);
  });

  it('works with no user agent at all', async () => {
    const result = await handleConnect(CONFIG, {});
    expect(result.status).toBe(200);
    expect((result.body as ConnectPayload).clients).toHaveLength(6);
  });
});

describe('verification routes', () => {
  it('refuses to start without an actor', async () => {
    const h = createHarness();
    const deps = { sessions: h.sessions, clock: h.deps.clock };
    const result = await handleStartVerification(deps, CONFIG, { body: { clientId: 'claude' } });
    expect(result.status).toBe(401);
  });

  it('requires a client id', async () => {
    const h = createHarness();
    const deps = { sessions: h.sessions, clock: h.deps.clock };
    const result = await handleStartVerification(deps, CONFIG, { actor: ACTOR, body: {} });
    expect(result.status).toBe(400);
  });

  it('rejects an unknown client id as a server error rather than a silent pass', async () => {
    const h = createHarness();
    const deps = { sessions: h.sessions, clock: h.deps.clock };
    const result = await handleStartVerification(deps, CONFIG, {
      actor: ACTOR,
      body: { clientId: 'netscape' },
    });
    expect(result.status).toBe(500);
  });

  it('round-trips the handle through polling and flips to connected', async () => {
    const h = createHarness({ fixedCode: '1' });
    const deps = { sessions: h.sessions, clock: h.deps.clock };

    const started = await handleStartVerification(deps, CONFIG, {
      actor: ACTOR,
      body: { clientId: 'claude' },
    });
    expect(started.status).toBe(200);
    const { handle, prompt } = started.body as { handle: VerificationHandle; prompt: string };
    expect(prompt).toBe('Vad vet du om mig?');

    // The handle goes to the browser and comes back, so it has to survive JSON.
    const roundTripped = JSON.parse(JSON.stringify(handle)) as VerificationHandle;
    expect(roundTripped.clientId).toBe('claude');

    const waiting = await handleVerificationStatus(deps, CONFIG, {
      actor: ACTOR,
      handle: roundTripped,
    });
    expect((waiting.body as { status: string }).status).toBe('waiting');

    h.setNow(new Date(h.now().getTime() + 4000));
    await h.sessions.simulateDelivery({
      personId: ACTOR.personId,
      agentClient: 'claude-desktop',
      method: 'mcp_instructions',
      at: h.now(),
    });

    const connected = await handleVerificationStatus(deps, CONFIG, {
      actor: ACTOR,
      handle: roundTripped,
    });
    expect(connected.body).toMatchObject({
      status: 'connected',
      agentClient: 'claude-desktop',
      deliveryMethod: 'mcp_instructions',
      degraded: false,
    });
  });

  it('needs a handle to poll', async () => {
    const h = createHarness();
    const deps = { sessions: h.sessions, clock: h.deps.clock };
    const result = await handleVerificationStatus(deps, CONFIG, { actor: ACTOR, body: {} });
    expect(result.status).toBe(400);
  });
});
