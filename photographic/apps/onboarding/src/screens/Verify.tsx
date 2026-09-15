import { useEffect, useRef, useState } from 'react';

import type { ClientDescriptor, VerificationState } from '@photographic/connect';

import type { Api } from '../api.js';

const POLL_INTERVAL_MS = 2000;

function time(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The screen that decides whether a person trusts the memory.
 *
 * It never reports success because the person clicked a button or because a config
 * file was written. Both are easy to observe and prove nothing. It waits until the
 * server has seen the profile actually delivered to a model.
 */
export function Verify({
  api,
  client,
  onDone,
}: {
  api: Api;
  client: ClientDescriptor;
  onDone: () => void;
}) {
  const [state, setState] = useState<VerificationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      try {
        const { handle } = await api.startVerification(client.id);

        const poll = async (): Promise<void> => {
          if (stopped.current) return;
          const next = await api.verificationStatus(handle);
          if (stopped.current) return;
          setState(next);
          if (next.status === 'waiting') timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        };

        await poll();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Något gick fel.');
      }
    })();

    return () => {
      stopped.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, client.id]);

  if (error) {
    return (
      <div className="card card--hero verify verify--bad">
        <div className="badge" aria-hidden="true">!</div>
        <p className="verify__prompt">{error}</p>
        <button type="button" className="btn" onClick={onDone}>
          Tillbaka
        </button>
      </div>
    );
  }

  if (!state || state.status === 'waiting') {
    const remaining = state?.status === 'waiting' ? Math.ceil(state.remainingMs / 1000) : null;

    return (
      <div className="card card--hero verify" aria-live="polite">
        <div className="pulse" aria-hidden="true" />
        <p className="meta" style={{ marginTop: 24 }}>
          Öppna {client.displayName} och fråga
        </p>
        <p className="verify__prompt">{client.verifyPrompt}</p>
        <p className="meta">
          {remaining === null
            ? 'Väntar på svar'
            : `Väntar på att ${client.displayName} hämtar din profil · ${remaining} s`}
        </p>
      </div>
    );
  }

  if (state.status === 'connected') {
    const degraded = state.degraded;

    return (
      <div className={degraded ? 'card card--hero verify verify--warn' : 'card card--hero verify verify--ok'}>
        <div className="badge" aria-hidden="true">
          {degraded ? '!' : '\u2713'}
        </div>
        <p className="verify__prompt">
          {client.displayName} anslöt {time(state.at)} och läste din profil.
        </p>
        {degraded ? (
          <p className="meta">
            Kontexten kom fram, men via en mindre pålitlig väg än {client.displayName} normalt
            klarar. Den hämtas bara när modellen själv frågar efter den.
          </p>
        ) : (
          <p className="meta">Nu vet {client.displayName} vem du är, i varje ny chatt.</p>
        )}
        <div style={{ marginTop: 28 }}>
          <button type="button" className="btn btn--primary" onClick={onDone}>
            Koppla något mer
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card card--hero verify verify--bad">
      <div className="badge" aria-hidden="true">!</div>
      <p className="verify__prompt">Inget kom fram från {client.displayName}.</p>
      <p className="meta">{state.remedy}</p>
      <div style={{ marginTop: 28 }}>
        <button type="button" className="btn" onClick={onDone}>
          Tillbaka
        </button>
      </div>
    </div>
  );
}
