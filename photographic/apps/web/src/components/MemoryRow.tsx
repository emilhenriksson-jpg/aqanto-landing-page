import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

import type { MemoryLine, RoomKind } from '../data/demo.js';
import { MemoryProvenance } from './MemoryProvenance.js';

/**
 * One memory line: body, quiet monospace short id, and the two things a person can do
 * with a line they are looking at — ask where it came from, and take it away.
 *
 * "Hur vet du det?" sits on the row rather than on a settings page because that is where
 * the question occurs. A person wondering how the system knows something is looking at
 * the something; making them navigate to a provenance screen and find the line again is
 * the same as not answering.
 *
 * Soft delete only, always with undo — DESIGN.md and the product contract require it.
 * `onForget` is optional: in a shared room the row is read-only, and a row nobody may
 * delete still has to be able to answer for itself.
 *
 * The deleted state says where the memory went and for how long, and links there. The
 * thirty-day trash is what makes deleting safe enough to do on one clear request, and the
 * moment a person presses "Ta bort" is the moment that fact is worth anything — knowing it
 * exists a week later, from a link at the foot of another screen, is knowing it too late.
 * `Ångra` stays first: same-turn undo is still the cheapest way back.
 */
export function MemoryRow({
  item,
  roomId,
  roomKind = 'personal',
  onForget,
  onRestore,
}: {
  item: Pick<MemoryLine, 'shortId' | 'body'>;
  roomId?: string;
  roomKind?: RoomKind;
  onForget?: (shortId: string) => void | Promise<void>;
  onRestore?: (shortId: string) => void | Promise<void>;
}) {
  const [gone, setGone] = useState(false);
  const [asking, setAsking] = useState(false);
  const panelId = `${useId()}-prov`;

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
            void onRestore?.(item.shortId);
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
          className="btn btn--quiet memory__why"
          aria-expanded={asking}
          aria-controls={panelId}
          onClick={() => setAsking((open) => !open)}
        >
          {asking ? 'Dölj ursprung' : 'Hur vet du det?'}
        </button>
        {onForget ? (
          <button
            type="button"
            className="btn btn--quiet memory__forget"
            aria-label={`Ta bort ${item.shortId}`}
            onClick={() => {
              setGone(true);
              void onForget(item.shortId);
            }}
          >
            Ta bort
          </button>
        ) : null}
      </div>
      {asking ? (
        <MemoryProvenance
          id={panelId}
          shortId={item.shortId}
          {...(roomId ? { roomId } : {})}
          roomKind={roomKind}
        />
      ) : null}
    </li>
  );
}
