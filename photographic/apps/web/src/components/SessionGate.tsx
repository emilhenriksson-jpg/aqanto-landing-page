import { useEffect, useState, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

import { ApiError, getAccount, isDemoMode } from '../api/index.js';

type SessionState = 'checking' | 'ready' | 'signed-out' | 'expired' | 'unavailable';

/**
 * Product routes only render after the browser's httpOnly cookie has proved itself.
 *
 * This keeps a signed-out person out of a convincing-but-dead app shell. `/start`
 * belongs to the onboarding bundle, so both hosts reuse the one public introduction
 * and phone sign-in flow rather than maintaining a second landing page in this app.
 */
export function SessionGate({ children }: { children?: ReactNode }) {
  const [state, setState] = useState<SessionState>(() => (isDemoMode() ? 'ready' : 'checking'));

  useEffect(() => {
    if (isDemoMode()) return;

    let cancelled = false;
    const expired = () => {
      if (!cancelled) setState('expired');
    };
    window.addEventListener('photographic:session-expired', expired);

    void getAccount()
      .then(() => {
        if (!cancelled) setState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (!(error instanceof ApiError) || error.status === 401) {
          setState(error instanceof ApiError && error.message.includes('Saknar') ? 'signed-out' : 'expired');
          return;
        }
        setState('unavailable');
      });

    return () => {
      cancelled = true;
      window.removeEventListener('photographic:session-expired', expired);
    };
  }, []);

  useEffect(() => {
    if (state !== 'signed-out' && state !== 'expired') return;
    window.location.replace(loginUrl(state === 'expired'));
  }, [state]);

  if (state === 'ready') return children ?? <Outlet />;
  if (state === 'unavailable') return children ?? <Outlet />;

  return (
    <main className="session-gate" aria-busy="true">
      <p className="section-block__empty">
        {state === 'checking' ? 'Hämtar ditt minne…' : 'Tar dig till inloggningen…'}
      </p>
    </main>
  );
}

function loginUrl(expired: boolean): string {
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const params = new URLSearchParams({
    fran: current,
    ...(expired ? { orsak: 'utgangen' } : {}),
  });
  return `/start?${params.toString()}`;
}
