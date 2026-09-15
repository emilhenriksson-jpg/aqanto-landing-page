import { Link, Navigate, useParams } from 'react-router-dom';

import { Wordmark } from '../components/Wordmark.js';
import { SECTION_LABELS, loadRoom, type MemoryLine } from '../data/demo.js';

/** Inside a shared room: title, brief as calm prose, memories grouped by kind. */
export function SharedRoom() {
  const { roomId = '' } = useParams();
  if (!roomId) return <Navigate to="/rum" replace />;
  if (roomId === 'personal') return <Navigate to="/" replace />;

  const room = loadRoom(roomId);
  if (!room) {
    return (
      <article className="page">
        <p className="section-block__empty">Rummet finns inte.</p>
        <Link to="/rum">Tillbaka till rum</Link>
      </article>
    );
  }

  const others = Math.max(0, room.memberCount - 1);
  const grouped = groupByKind(room.memories);

  return (
    <article className="page">
      <header className="hero hero--shared">
        <Wordmark />
        <p className="hero__crumb">
          <Link to="/rum">Rum</Link>
          <span aria-hidden="true"> · </span>
          <span>{room.title}</span>
        </p>
        <h1 className="hero__title">{room.title}</h1>
        <p className="hero__lede">
          {room.brief ??
            'Inget sparat än. Säg till Claude eller ChatGPT att lägga något här.'}
        </p>
        {room.memberNames.length > 0 ? (
          <div className="avatars avatars--hero" aria-label="Medlemmar">
            {room.memberNames.map((name) => (
              <span key={name} className="avatar" title={name}>
                {initials(name)}
              </span>
            ))}
          </div>
        ) : null}
        <p className="meta">
          {others === 0
            ? 'Bara du'
            : others === 1
              ? 'Delad med 1 person'
              : `Delad med ${others} personer`}
        </p>
      </header>

      {grouped.length === 0 ? (
        <p className="section-block__empty">Inget sparat i det här rummet ännu.</p>
      ) : (
        grouped.map(({ kind, items }) => (
          <section key={kind} className="section-block" aria-labelledby={`mem-${kind}`}>
            <h2 id={`mem-${kind}`} className="section-block__title">
              {SECTION_LABELS[kind]}
            </h2>
            <ul className="card card--group">
              {items.map((item) => (
                <li key={item.shortId} className="memory">
                  <p className="memory__body">{item.body}</p>
                  <div className="memory__meta">
                    <span className="mono chip">{item.shortId}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </article>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return `${parts[0]!.slice(0, 1)}${parts[parts.length - 1]!.slice(0, 1)}`.toUpperCase();
}

function groupByKind(
  items: MemoryLine[],
): Array<{ kind: MemoryLine['kind']; items: MemoryLine[] }> {
  const order: MemoryLine['kind'][] = [
    'identity',
    'fact',
    'preference',
    'instruction',
    'never',
    'decision',
    'note',
  ];
  return order
    .map((kind) => ({ kind, items: items.filter((item) => item.kind === kind) }))
    .filter((group) => group.items.length > 0);
}
