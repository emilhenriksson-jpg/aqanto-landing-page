import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_API_BASE, apiBase, getSessionToken, isDemoMode } from './config.js';

describe('api config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it('defaults to demo mode unless VITE_USE_DEMO is 0', () => {
    expect(isDemoMode()).toBe(true);
    vi.stubEnv('VITE_USE_DEMO', '1');
    expect(isDemoMode()).toBe(true);
    vi.stubEnv('VITE_USE_DEMO', '0');
    expect(isDemoMode()).toBe(false);
  });

  it('defaults the API base to the REST port', () => {
    expect(apiBase()).toBe(DEFAULT_API_BASE);
    vi.stubEnv('VITE_API_BASE', 'http://localhost:8787/');
    expect(apiBase()).toBe('http://localhost:8787');
  });

  it('reads the session bearer from localStorage when present', () => {
    expect(getSessionToken()).toBeNull();
    localStorage.setItem('photographic_session', ' tok-1 ');
    expect(getSessionToken()).toBe('tok-1');
  });
});
