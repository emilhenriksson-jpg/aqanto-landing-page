import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import type { Step } from './App.js';
import { httpApi } from './api.js';
import './styles/app.css';

/** `/invite/<token>` is the only deep entry point; everything else starts at sign-up. */
function initialStep(): Step | undefined {
  const match = /^\/invite\/([^/]+)/.exec(window.location.pathname);
  return match?.[1] ? { name: 'invite', token: decodeURIComponent(match[1]) } : undefined;
}

const root = document.querySelector('#root');
if (!root) throw new Error('missing #root');

const step = initialStep();

createRoot(root).render(
  <StrictMode>
    <App api={httpApi} {...(step ? { initial: step } : {})} />
  </StrictMode>,
);
