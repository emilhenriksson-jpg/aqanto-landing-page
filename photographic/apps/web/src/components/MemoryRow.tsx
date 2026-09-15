import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { MemoryLine } from '../data/demo.js';

/**
 * One memory line: body + quiet monospace short id, delete with undo.
 * Soft delete only — DESIGN.md and the product contract require undo.
 *
 * The deleted state says where the memory went and for how long, and links there. The
 * thirty-day trash is what makes deleting safe enough to do on one clear request, and the
 * moment a person presses "Ta bort" is the moment that fact is worth anything — knowing it
 * exists a week later, from a link at the foot of another screen, is knowing it too late.
 * `Ångra` stays first: same-turn undo is still the cheapest way back.
 */
export function MemoryRow({
  item,
  onForget,
  onRestore,
}: {
  item: Pick<MemoryLine, 'shortId' | 'body'>;
  onForget: (shortId: string) => void | Promise<void>;
  onRestore: (shortId: string) => void | Promise<void>;
}) {
  const [gone, setGone] = useState(false);

  if (gone) {
    return (
      <li className="memory memory--gone">
        <div className="memory__gone-text">
          <span className="memory__body">Borttaget</span>
          <span className="meta">
            Ligger i <Link to="/papperskorg">papperskorgen</Link> i 30 dagar.
          </span>
        </div>
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => {
            setGone(false);
            onRestore(item.shortId);
          }}
        >
          Ångra
        </button>
      </li>
    );
  }

  return (
    <li className="memory">
      <p className="memory__body">{item.body}</p>
      <div className="memory__meta">
        <span className="mono chip">{item.shortId}</span>
        <button
          type="button"
          className="btn btn--quiet memory__forget"
          aria-label={`Ta bort ${item.shortId}`}
          onClick={() => {
            setGone(true);
            onForget(item.shortId);
          }}
        >
          Ta bort
        </button>
      </div>
    </li>
  );
}
