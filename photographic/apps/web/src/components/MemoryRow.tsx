import { useState } from 'react';

import type { MemoryLine } from '../data/demo.js';

/**
 * One memory line: body + quiet monospace short id, delete with undo.
 * Soft delete only — DESIGN.md and the product contract require undo.
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
        <span className="memory__body">Borttaget</span>
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
