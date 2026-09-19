import { useState } from 'react';
import { apiFetch } from '../api/client.js';
import { isDemoMode } from '../api/config.js';
import type { ApprovalItem } from '../data/demo.js';

interface Result { id: string; status: 'saved' | 'dismissed' | 'already_handled' | 'needs_review' | 'failed' }
export function ContributionReview({ items, onResolved, onRefresh, onPaused }: {
  items: ApprovalItem[]; onResolved: (ids: string[], receipt: string) => void; onPaused?: () => void; onRefresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(() => new Set(items.filter(item => !item.contribution?.reviewRequired).map(item => item.id)));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const ids = items.filter(item => selected.has(item.id)).map(item => item.id);
  const special = items.filter(item => item.contribution?.reviewRequired);
  async function resolve(accept: boolean) {
    if (busy) return;
    setBusy(true); setMessage('');
    const targetIds = accept ? ids : items.map(item => item.id);
    try {
      const results: Result[] = [];
      for (let start = 0; start < targetIds.length; start += 100) {
        const chunk = targetIds.slice(start, start + 100);
        const response = isDemoMode() ? { results: chunk.map(id => ({ id, status: accept ? 'saved' as const : 'dismissed' as const })) }
          : await apiFetch<{ results: Result[] }>('/v1/context/contributions/resolve', {
            method: 'POST', body: JSON.stringify({ ids: chunk,
              expectedReasons: Object.fromEntries(items.filter(item => chunk.includes(item.id)).map(item => [item.id, item.reason])),
              reviewedIds: special.filter(item => chunk.includes(item.id) && selected.has(item.id)).map(item => item.id), accept }),
          });
        results.push(...response.results);
      }
      const completed = results.filter(result => ['saved', 'dismissed', 'already_handled'].includes(result.status));
      const saved = completed.filter(result => result.status === 'saved').length;
      const dismissed = completed.filter(result => result.status === 'dismissed').length;
      const already = completed.filter(result => result.status === 'already_handled').length;
      onResolved(completed.map(result => result.id), `Sparade: ${saved}. Avfärdade: ${dismissed}. Redan hanterade: ${already}.`);
      if (!accept) onPaused?.();
      const remaining = results.length - completed.length;
      if (remaining) {
        setMessage(`${completed.length} hanterade. ${remaining} behöver granskas igen eller kunde inte sparas. De står kvar.`);
        // Changed conflicts invalidate the prior checkbox selection.
        setSelected(new Set());
        await onRefresh();
      } else setMessage(accept ? `${completed.length} uppgifter hanterade.` : 'Underlaget är avfärdat och nya erbjudanden pausade.');
    } catch { setMessage('Kunde inte bekräfta resultatet. Uppgifterna står kvar; det går att försöka igen utan dubbletter.'); }
    finally { setBusy(false); }
  }
  async function pause() {
    if (busy) return;
    setBusy(true);
    try {
      if (!isDemoMode()) await apiFetch('/v1/context/contributions/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
      onPaused?.();
      setMessage('Pausat hos alla dina AI:er. Underlaget finns kvar här när du vill fortsätta.');
    } catch { setMessage('Kunde inte pausa. Försök igen.'); }
    finally { setBusy(false); }
  }
  return <li className="approval-card card contribution-review">
    <h2>Sammanhang från {items[0]?.clientLabel ?? 'din AI'}</h2>
    <p>{items.length} {items.length === 1 ? 'uppgift' : 'uppgifter'} att ta ställning till. De sparas i ditt personliga minne och kan sedan hämtas av dina anslutna AI:er. De delas inte med andra personer.</p>
    {special.length > 0 && <p>{special.length} {special.length === 1 ? 'uppgift kräver särskild granskning och är inte förvald' : 'uppgifter kräver särskild granskning och är inte förvalda'}.</p>}
    <details>
      <summary>Granska och välj uppgifter</summary>
      <ul className="contribution-review__items">{items.map(item => <li key={item.id}>
        <label><input type="checkbox" checked={selected.has(item.id)} disabled={busy} onChange={event => {
          const checked = event.target.checked;
          setSelected(current => { const next = new Set(current); if (checked) next.add(item.id); else next.delete(item.id); return next; });
        }} /><span>{item.body}</span></label>
        <p className="meta">{item.reason}</p>
        {item.contribution?.reviewRequired && <p className="meta">Markera först när du har granskat denna uppgift.</p>}
      </li>)}</ul>
    </details>
    {message && <p role="status">{message}</p>}
    <div className="approval-card__actions">
      <button className="btn btn--brand" disabled={busy || !ids.length} onClick={() => void resolve(true).catch(() => setMessage('Kunde inte bekräfta resultatet.'))}>{busy ? 'Bearbetar…' : ids.length === items.length && !special.length ? 'Dela allt nytt' : `Dela ${ids.length} ${ids.length === 1 ? 'vald uppgift' : 'valda uppgifter'}`}</button>
      <button className="btn" disabled={busy} onClick={() => void pause().catch(() => setMessage('Kunde inte pausa.'))}>Inte nu</button>
      <button className="btn btn--quiet" disabled={busy} onClick={() => void resolve(false).catch(() => setMessage('Kunde inte bekräfta resultatet.'))}>Avfärda underlaget</button>
    </div>
  </li>;
}
