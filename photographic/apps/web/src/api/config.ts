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

/**
 * Where the API is, which in a real deploy is "here".
 *
 * An explicit `VITE_API_BASE` still wins. Otherwise a production build talks to its own
 * origin, and only a dev build falls back to `DEFAULT_API_BASE` — because that default
 * exists for one situation, the Vite dev server on :5173 calling `apps/rest` on :8787.
 *
 * It used to be the default everywhere, which was wrong in a way that only showed up
 * once the app was actually served: the deployed bundle asked `http://127.0.0.1:8787`
 * for the person's memory, meaning the visitor's *own machine*, so every screen failed
 * with "Kunde inte hämta just nu". Same origin also matters now beyond reachability —
 * the session is an httpOnly cookie, and a cross-origin request would not carry it.
 */
export function apiBase(): string {
  const raw = import.meta.env.VITE_API_BASE;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim().replace(/\/+$/, '');

  // Empty string: `${apiBase()}/v1/profile` becomes a relative URL, which is the whole
  // point — it follows the origin the app was loaded from, `.fly.dev` or the real
  // hostname, with nothing to keep in sync.
  return import.meta.env.DEV ? DEFAULT_API_BASE : '';
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
