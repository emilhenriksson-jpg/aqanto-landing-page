import { Link, Navigate, useParams } from 'react-router-dom';

import { Avatars } from '../components/Avatars.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { DocumentsSection } from '../components/DocumentsSection.js';
import { Wordmark } from '../components/Wordmark.js';
import {
  DEMO_ACTIVITY,
  SECTION_LABELS,
  loadRoom,
  type DocumentLine,
  type MemoryLine,
  type RoomDetail,
} from '../data/demo.js';
import { loadSharedRoomFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/** Inside a shared room: title, brief as calm prose, memories, documents, activity. */
export function SharedRoom({ documents }: { documents?: DocumentLine[] } = {}) {
  const { roomId = '' } = useParams();
  if (!roomId) return <Navigate to="/rum" replace />;
  if (roomId === 'personal') return <Navigate to="/" replace />;

  const state = useRoomData(
    `shared:${roomId}`,
    () => loadRoom(roomId),
    () => loadSharedRoomFromApi(roomId),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar rummet…" />;
  if (state.status === 'error') {
    return <CalmState title="Rum" message={state.message} backToRooms />;
  }
  if (!state.data) {
    return (
      <CalmState title="Rum" message="Rummet finns inte." backToRooms />
    );
  }

  return <SharedRoomReady room={state.data} documents={documents} />;
}

function SharedRoomReady({
  room,
  documents,
}: {
  room: RoomDetail;
  documents?: DocumentLine[];
}) {
  const grouped = groupByKind(room.memories);
  const activity = DEMO_ACTIVITY[room.id] ?? [];
  // Names the other members rather than counting them — `room.memberNames` already
  // excludes the viewer (see `loadSharedRoomFromApi`), so an empty list genuinely means
  // nobody else has joined yet.
  const memberLine =
    room.memberNames.length === 0 ? 'Bara du' : `Delad med ${joinNames(room.memberNames)}`;

  return (
    <article className="page page--shared">
      <header className="hero hero--shared">
        <Wordmark />
        <p className="hero__crumb">
          <Link to="/rum">Rum</Link>
          <span aria-hidden="true"> · </span>
          <span>{room.title}</span>
        </p>
        <h1 className="hero__title">{room.title}</h1>
        <Avatars names={room.memberNames} variant="hero" />
        <p className="hero__lede">
          {room.brief ??
            'Inget sparat än. Säg till Claude eller ChatGPT att lägga något här.'}
        </p>
        <p className="meta">{memberLine}</p>
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

      <DocumentsSection roomId={room.id} documents={documents} />

      <section className="section-block" aria-labelledby="room-activity">
        <h2 id="room-activity" className="section-block__title">
          Aktivitet
        </h2>
        {activity.length === 0 ? (
          <p className="section-block__empty">Ingen aktivitet ännu.</p>
        ) : (
          <ul className="activity">
            {activity.map((item) => (
              <li key={item.id} className="activity__row">
                <span className="meta">{item.when}</span>
                <span>{item.body}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

/** "Anna", "Anna och Jacob", "Anna, Jacob och Vera" — never a bare Oxford list. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} och ${names[names.length - 1]}`;
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
