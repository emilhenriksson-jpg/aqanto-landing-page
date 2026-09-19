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
    <summary>{paused ? 'Kontextförslag är pausade' : 'Börja med det din AI redan vet'}</summary>
    <p>Din AI jämför den kontext den har tillgång till med Photographic och erbjuder att dela det som saknas. Du granskar och godkänner innan det blir ett minne. Frågor och förslag om fler källor kommer först när de behövs.</p>
    <button className="btn btn--quiet" disabled={busy || paused === null} onClick={() => void change().catch(() => setMessage('Kunde inte spara ändringen.'))}>{paused ? 'Återuppta kontextförslag' : 'Pausa kontextförslag'}</button>
    {message && <p role="status">{message}</p>}
  </details>;
}
