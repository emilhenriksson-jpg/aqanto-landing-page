import { useState } from 'react';
import { Link } from 'react-router-dom';

import { isDemoMode, restoreTrash } from '../api/index.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { DEMO_TRASH, type TrashLine } from '../data/demo.js';
import { loadTrashFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * Soft-deleted memories still recoverable for 30 days.
 * Quiet shelf, not a dump — one Wordmark, lines with Återställ.
 * Live: GET /v1/trash + POST /v1/trash/:shortId/restore behind VITE_USE_DEMO=0.
 */
export function Trash() {
  const state = useRoomData(
    'trash',
    () => DEMO_TRASH,
    () => loadTrashFromApi(),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar papperskorgen…" />;
  if (state.status === 'error') {
    return <CalmState title="Papperskorg" message={state.message} />;
  }

  return <TrashReady initial={state.data} />;
}

function TrashReady({ initial }: { initial: TrashLine[] }) {
  const [entries, setEntries] = useState(initial);

  async function restore(shortId: string) {
    setEntries((current) => current.filter((entry) => entry.shortId !== shortId));
    if (isDemoMode()) return;
    try {
      await restoreTrash(shortId);
    } catch {
      // Row already cleared locally; network restore is best-effort.
    }
  }

  return (
    <article className="page page--trash">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">Papperskorg</h1>
        <p className="page-head__lede">
          Borttaget ligger kvar i 30 dagar. Återställ det du vill ha tillbaka.
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="section-block__empty">Papperskorgen är tom.</p>
      ) : (
        <ul className="trash-list">
          {entries.map((entry) => (
            <li key={entry.shortId} className="trash-row">
              <div className="trash-row__main">
                <p className="trash-row__body">{entry.body}</p>
                <p className="meta">
                  {entry.roomTitle}
                  {entry.deleteReason ? ` · ${entry.deleteReason}` : ''}
                  {` · ${entry.daysLabel}`}
                </p>
              </div>
              <div className="trash-row__actions">
                <span className="mono chip">{entry.shortId}</span>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => void restore(entry.shortId)}
                >
                  Återställ
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="page-foot">
        <Link to="/" className="page-foot__link">
          Tillbaka till ditt rum
        </Link>
      </p>
    </article>
  );
}
