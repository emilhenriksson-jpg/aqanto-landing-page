import { Link, Navigate, useParams } from 'react-router-dom';

import { Avatars } from '../components/Avatars.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { DocumentsSection } from '../components/DocumentsSection.js';
import { Wordmark } from '../components/Wordmark.js';
import {
  DEMO_ACTIVITY,
  SECTION_LABELS,
  loadRoom,
  type ActivityLine,
  type DocumentLine,
  type MemoryLine,
  type RoomDetail,
} from '../data/demo.js';
import { loadRoomActivityFromApi, loadSharedRoomFromApi } from '../data/load.js';
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
  const others = Math.max(0, room.memberCount - 1);
  const grouped = groupByKind(room.memories);
  const memberLine =
    others === 0
      ? 'Bara du'
      : others === 1
        ? 'Delad med 1 person'
        : `Delad med ${others} personer`;

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

      <ActivitySection roomId={room.id} />
    </article>
  );
}

/**
 * What has happened in this room, read from the event log.
 *
 * Loaded here rather than with the room so that a slow or failing history call leaves the
 * room's memories on screen — the feed is context, and losing it must not cost a person
 * the room. The demo fixtures are keyed by the slugs the demo rooms use, which is why this
 * asks the flag rather than looking up a real room id in them: that lookup missed on every
 * real room and reported "Ingen aktivitet ännu" forever.
 */
function ActivitySection({ roomId }: { roomId: string }) {
  const state = useRoomData(
    `activity:${roomId}`,
    (): ActivityLine[] => DEMO_ACTIVITY[roomId] ?? [],
    () => loadRoomActivityFromApi(roomId),
  );

  const entries = state.status === 'ready' ? state.data : [];

  return (
    <section className="section-block" aria-labelledby="room-activity">
      <h2 id="room-activity" className="section-block__title">
        Aktivitet
      </h2>
      {state.status === 'loading' ? (
        <p className="section-block__empty">Hämtar aktivitet…</p>
      ) : state.status === 'error' ? (
        <p className="section-block__empty">{state.message}</p>
      ) : entries.length === 0 ? (
        <p className="section-block__empty">Ingen aktivitet ännu.</p>
      ) : (
        <ul className="activity">
          {entries.map((item) => (
            <li key={item.id} className="activity__row">
              <span className="meta">{item.when}</span>
              <span>{item.body}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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
