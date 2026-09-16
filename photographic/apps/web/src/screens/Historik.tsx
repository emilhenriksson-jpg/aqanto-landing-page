import { Link } from 'react-router-dom';

import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { DEMO_HISTORY, type HistoryLine } from '../data/demo.js';
import { loadHistoryFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * Honesty about what changed — sparse when + what, not an audit dashboard.
 * Live: GET /v1/history behind VITE_USE_DEMO=0.
 */
export function Historik() {
  const state = useRoomData(
    'historik',
    () => DEMO_HISTORY,
    () => loadHistoryFromApi(),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar historiken…" />;
  if (state.status === 'error') {
    return <CalmState title="Historik" message={state.message} />;
  }

  return <HistorikReady entries={state.data} />;
}

function HistorikReady({ entries }: { entries: HistoryLine[] }) {
  return (
    <article className="page page--historik">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">Historik</h1>
        <p className="page-head__lede">
          Vad som sparats, ändrats eller tagits bort — utan brus.
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="section-block__empty">Inget har hänt i minnet än.</p>
      ) : (
        <ul className="activity historik-list">
          {entries.map((entry) => (
            <li key={entry.id} className="activity__row">
              <span className="meta">{entry.when}</span>
              <span>{entry.body}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="page-foot">
        <Link to="/personligt" className="page-foot__link">
          Tillbaka till ditt rum
        </Link>
      </p>
    </article>
  );
}
