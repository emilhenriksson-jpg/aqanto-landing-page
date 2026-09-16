import { Link, Navigate, useParams } from 'react-router-dom';

import { Avatars } from '../components/Avatars.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { DocumentsSection } from '../components/DocumentsSection.js';
import { MemoryRow } from '../components/MemoryRow.js';
import { PendingApprovals } from '../components/PendingApprovals.js';
import { Wordmark } from '../components/Wordmark.js';
import {
  DEMO_ACTIVITY,
  loadRoom,
  type ActivityLine,
  type DocumentLine,
  type RoomDetail,
} from '../data/demo.js';
import { loadRoomActivityFromApi, loadSharedRoomFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * Inside a shared room: title, brief as calm prose, memories, documents, activity.
 *
 * The two redirects sit here, above any hook, and the loading is a separate component
 * below. It used to be one component that returned a `<Navigate>` before calling
 * `useRoomData`, which is a conditionally called hook: React then matches hook state by
 * call order against a previous render that had one more hook, so the room reads state
 * belonging to something else. That does not fail loudly — it is a screen showing a person
 * their own memory being subtly wrong on some renders and right on others.
 */
export function SharedRoom({ documents }: { documents?: DocumentLine[] } = {}) {
  const { roomId = '' } = useParams();
  if (!roomId) return <Navigate to="/rum" replace />;
  if (roomId === 'personal') return <Navigate to="/" replace />;

  return <SharedRoomLoader roomId={roomId} documents={documents} />;
}

function SharedRoomLoader({
  roomId,
  documents,
}: {
  roomId: string;
  documents?: DocumentLine[];
}) {
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
  // Names the other members rather than counting them — `room.memberNames` already
  // excludes the viewer (see `loadSharedRoomFromApi`), so an empty list genuinely means
  // nobody else has joined yet.
  const memberLine =
    room.memberNames.length === 0
      ? 'Bara du kan se det här rummet'
      : `Delad med ${joinNames(room.memberNames)}`;

  return (
    <article className="page page--shared">
      <header className="hero hero--shared">
        <Wordmark />
        <p className="room-intro__crumb">
          <Link to="/rum">Rum</Link>
        </p>
        <h1 className="hero__title">{room.title}</h1>
        <p className="hero__lede">
          {room.brief ??
            'Inget sparat än. Säg till Claude eller ChatGPT att lägga något här.'}
        </p>
        <div className="room-intro__meta">
          <Avatars names={room.memberNames} variant="hero" />
          <p className="meta">{memberLine}</p>
        </div>
      </header>

      {/*
        Room-scoped, because every write into a shared room goes to the queue by design.
        Without this, a room the person has been writing to all week simply looks empty.
      */}
      <PendingApprovals roomId={room.id} />

      <section className="section-block room-collection" aria-labelledby="room-memories">
        <div className="room-collection__head">
          <h2 id="room-memories" className="section-block__title">
            I rummet
          </h2>
          {room.memories.length > 0 ? (
            <p className="meta">
              {room.memories.length === 1 ? '1 minne' : `${room.memories.length} minnen`}
            </p>
          ) : null}
        </div>
        {room.memories.length === 0 ? (
          <p className="section-block__empty">Inget sparat i det här rummet ännu.</p>
        ) : (
          <ul className="card card--group room-shelf">
            {room.memories.map((item) => (
              // No delete here — only the author may remove a shared memory, and the
              // row is still owed an answer to "hur vet du det?" either way.
              <MemoryRow key={item.shortId} item={item} roomId={room.id} roomKind="shared" />
            ))}
          </ul>
        )}
      </section>

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

/** "Anna", "Anna och Jacob", "Anna, Jacob och Vera" — never a bare Oxford list. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} och ${names[names.length - 1]}`;
}
