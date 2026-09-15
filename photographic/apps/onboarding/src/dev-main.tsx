/**
 * Design harness. Runs the whole onboarding flow against the fake API, so the screens
 * can be looked at before the backend exists:
 *
 *   pnpm --filter @photographic/onboarding dev     -> opens /dev.html
 *
 * Dev only. The production build has index.html as its single entry, so none of the
 * fake data reaches a bundle.
 *
 * The code is 424242 and every client card behaves as it will in production. The
 * verification screen waits four seconds and then reports Claude as connected, which is
 * roughly how long a real handshake takes.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import type { VerificationState } from '@photographic/connect';

import { App } from './App.js';
import type { Step } from './App.js';
import { FakeApi } from './test/fake-api.js';
import './styles/app.css';

const now = new Date();

const api = new FakeApi({
  verification: [
    { status: 'waiting', prompt: 'Vad vet du om mig?', elapsedMs: 0, remainingMs: 90_000 },
    { status: 'waiting', prompt: 'Vad vet du om mig?', elapsedMs: 2000, remainingMs: 88_000 },
    {
      status: 'connected',
      agentClient: 'claude-desktop',
      deliveryMethod: 'mcp_instructions',
      at: now,
      degraded: false,
    },
  ] satisfies VerificationState[],
  invite: {
    room: { id: 'room-2', title: 'Buyersclub Ledning', description: 'Ledningsgruppen' },
    invitedByName: 'Emil',
    preview:
      'Vi beslutade att skjuta förvärvet till Q3 för att hinna med due diligence.\n' +
      'Jacob tar fram ett uppdaterat underlag före nästa möte.',
  },
  profile: 'Allergisk mot ketchup. Dottern heter Vera. Utmana alltid mina idéer.',
  health: [
    {
      agentClient: 'claude-desktop',
      displayName: 'Claude',
      lastSeenAt: now.toISOString(),
      profileDelivered: true,
      deliveryMethod: 'mcp_instructions',
      degraded: false,
    },
    {
      agentClient: 'chatgpt-web',
      displayName: 'ChatGPT',
      lastSeenAt: now.toISOString(),
      profileDelivered: true,
      deliveryMethod: 'tool_call',
      degraded: true,
    },
    {
      agentClient: 'codex',
      displayName: 'Codex',
      lastSeenAt: now.toISOString(),
      profileDelivered: false,
      deliveryMethod: null,
      degraded: false,
    },
  ],
});

/** `?screen=connect|invite|verify` jumps straight to one screen. */
function initialStep(): Step | undefined {
  const screen = new URLSearchParams(window.location.search).get('screen');
  if (screen === 'connect') return { name: 'connect' };
  if (screen === 'invite') return { name: 'invite', token: 'demo' };
  return undefined;
}

const root = document.querySelector('#root');
if (!root) throw new Error('missing #root');

const step = initialStep();

createRoot(root).render(
  <StrictMode>
    <App api={api} {...(step ? { initial: step } : {})} />
  </StrictMode>,
);
