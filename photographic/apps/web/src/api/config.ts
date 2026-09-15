/**
 * Browser → REST wiring knobs.
 *
 * Demo stays the default so `pnpm --filter @photographic/web test` and a casual
 * `pnpm dev` still show the designed screens without a signed-in API session.
 */

/** Same default port as `apps/rest` (`DEFAULT_CONFIG.port`). */
export const DEFAULT_API_BASE = 'http://127.0.0.1:8787';

/** Bearer token from onboarding / signup, if the person already signed in. */
export const SESSION_STORAGE_KEY = 'photographic_session';

export function apiBase(): string {
  const raw = import.meta.env.VITE_API_BASE;
  const base = (typeof raw === 'string' && raw.trim().length > 0 ? raw : DEFAULT_API_BASE).trim();
  return base.replace(/\/+$/, '');
}

/**
 * Demo data unless explicitly flipped off with `VITE_USE_DEMO=0`.
 * `1`, unset, and any other value keep the demo path.
 */
export function isDemoMode(): boolean {
  return import.meta.env.VITE_USE_DEMO !== '0';
}

export function getSessionToken(): string | null {
  try {
    const value = localStorage.getItem(SESSION_STORAGE_KEY);
    return value && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}
