import { useState } from 'react';
import { Link } from 'react-router-dom';

import { isDemoMode, restoreTrash } from '../api/index.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { DEMO_TRASH, type TrashLine } from '../data/demo.js';
import { loadTrashFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * Everything still recoverable for 30 days — memories and deleted documents in one shelf.
 *
 * One place to look, because "where did the thing I deleted go" is one question and a person
 * does not sort their own regret by data type. Documents used to have their own listing with
 * no screen at all, so a deleted file was recoverable in principle and invisible in practice.
 *
 * A file shows its filename and a paperclip; a memory shows its text and its speakable id.
 * The rows differ because the things differ — but they interleave by when they were deleted,
 * which is the order a person remembers doing it in.
 *
 * Quiet shelf, not a dump — one Wordmark, lines with Återställ.
 * Live: GET /v1/trash + POST /v1/trash/:handle/restore behind VITE_USE_DEMO=0.
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

  async function restore(handle: string) {
    setEntries((current) => current.filter((entry) => entry.handle !== handle));
    if (isDemoMode()) return;
    try {
      await restoreTrash(handle);
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
          Borttaget ligger kvar i 30 dagar — både minnen och dokument. Återställ det du vill ha
          tillbaka.
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="section-block__empty">Papperskorgen är tom.</p>
      ) : (
        <ul className="trash-list">
          {entries.map((entry) => (
            <li
              key={entry.handle}
              className={`trash-row${entry.type === 'document' ? ' trash-row--document' : ''}`}
            >
              <div className="trash-row__main">
                <p className="trash-row__body">
                  {entry.type === 'document' ? '📄 ' : ''}
                  {entry.body}
                </p>
                <p className="meta">
                  {entry.roomTitle}
                  {entry.deleteReason ? ` · ${entry.deleteReason}` : ''}
                  {` · ${entry.daysLabel}`}
                </p>
              </div>
              <div className="trash-row__actions">
                {/* A memory's short id is speakable and worth showing; a document's uuid is
                    neither, so the row says what it is instead of printing 36 characters. */}
                <span className="mono chip">
                  {entry.type === 'document' ? 'dokument' : entry.shortId}
                </span>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => void restore(entry.handle)}
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
