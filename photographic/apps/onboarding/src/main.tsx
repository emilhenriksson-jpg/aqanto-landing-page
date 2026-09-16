import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import type { Step } from './App.js';
import { httpApi } from './api.js';
import './styles/app.css';

/**
 * Three deep entry points; everything else starts at sign-up.
 *
 * `/start` is the public page — what the apex hostname should serve to someone who has
 * heard of Photographic and has no account.
 * `/invite/<token>` is someone being shown a room before they have an account.
 * `/login?auth_request=<id>` is an AI client's authorization request, parked by the
 * authorization server and waiting on the person to answer it.
 */
function initialStep(): Step | undefined {
  if (/^\/start\/?$/.test(window.location.pathname)) {
    const params = new URLSearchParams(window.location.search);
    const returnTo = safeReturnTo(params.get('fran'));
    const reason = params.get('orsak');
    return {
      name: 'landing',
      ...(returnTo ? { returnTo } : {}),
      ...(reason === 'utloggad'
        ? { notice: 'Du är utloggad.' }
        : reason === 'utgangen'
          ? { notice: 'Din session har gått ut. Logga in igen för att fortsätta.' }
          : {}),
    };
  }

  const invite = /^\/invite\/([^/]+)/.exec(window.location.pathname);
  if (invite?.[1]) return { name: 'invite', token: decodeURIComponent(invite[1]) };

  const authRequest = new URLSearchParams(window.location.search).get('auth_request');
  if (authRequest) return { name: 'approve', requestId: authRequest };

  return undefined;
}

/** Never turn a query string on a public page into a redirect off this origin. */
function safeReturnTo(value: string | null): string | undefined {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return undefined;
  return value;
}

const root = document.querySelector('#root');
if (!root) throw new Error('missing #root');

const step = initialStep();

createRoot(root).render(
  <StrictMode>
    <App api={httpApi} {...(step ? { initial: step } : {})} />
  </StrictMode>,
);
