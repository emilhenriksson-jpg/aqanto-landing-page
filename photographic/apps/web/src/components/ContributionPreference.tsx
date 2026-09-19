import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';
import { isDemoMode } from '../api/config.js';

export function ContributionPreference() {
  const [paused, setPaused] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    if (isDemoMode()) { setPaused(false); return; }
    apiFetch<{ paused: boolean }>('/v1/context/contributions').then(
      state => { if (active) setPaused(state.paused); },
      () => { if (active) setMessage('Kunde inte läsa om erbjudanden är pausade.'); },
    );
    return () => { active = false; };
  }, []);
  async function change() {
    if (busy || paused === null) return;
    setBusy(true); setMessage('');
    try {
      const state = isDemoMode() ? { paused: !paused } : await apiFetch<{ paused: boolean }>('/v1/context/contributions/pause', {
        method: 'POST', body: JSON.stringify({ paused: !paused }),
      });
      setPaused(state.paused);
      setMessage(state.paused ? 'Erbjudanden är pausade hos alla dina AI:er.' : 'Din AI kan åter erbjuda att dela ny kontext.');
    } catch { setMessage('Ändringen kunde inte sparas. Försök igen.'); }
    finally { setBusy(false); }
  }
  return <details className="contribution-preference">
    <summary>{paused ? 'Minnesförslag är pausade' : 'Låt minnet växa i din takt'}</summary>
    <p>När det passar i samtalet kan din AI jämföra det den redan vet om dig med Photographic. Det som saknas kan bli ett privat förslag som du granskar innan något blir ett minne. Du kan säga ”inte nu” och fortsätta prata. Pausen gäller alla dina AI:er tills du återupptar förslagen.</p>
    <button className="btn btn--quiet" disabled={busy || paused === null} onClick={() => void change().catch(() => setMessage('Kunde inte spara ändringen.'))}>{paused ? 'Återuppta minnesförslag' : 'Pausa minnesförslag'}</button>
    {message && <p role="status">{message}</p>}
  </details>;
}
