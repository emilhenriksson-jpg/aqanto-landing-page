import { Link } from 'react-router-dom';

import { Wordmark } from '../components/Wordmark.js';
import { DEMO_ROOMS, type RoomCard } from '../data/demo.js';

/**
 * Secondary navigation: where can I go.
 * Personal room first, always, visually distinct — violet-tinted, never archivable.
 */
export function Rooms() {
  const personal = DEMO_ROOMS.find((room) => room.kind === 'personal');
  const shared = DEMO_ROOMS.filter((room) => room.kind === 'shared');

  return (
    <article className="page">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">Rum</h1>
        <p className="page-head__lede">Välj vart du går. Ditt rum ligger alltid först.</p>
      </header>

      <div className="room-grid">
        {personal ? <RoomTile room={personal} featured /> : null}
        {shared.map((room) => (
          <RoomTile key={room.id} room={room} />
        ))}
      </div>
    </article>
  );
}

function RoomTile({ room, featured = false }: { room: RoomCard; featured?: boolean }) {
  const href = room.kind === 'personal' ? '/' : `/rum/${room.id}`;
  const others = Math.max(0, room.memberCount - 1);
  const label =
    room.kind === 'personal'
      ? 'Öppna ditt rum'
      : `Öppna ${room.title}`;

  return (
    <Link
      to={href}
      aria-label={label}
      className={featured ? 'room-card room-card--personal' : 'room-card'}
    >
      <div className="room-card__top">
        <h2 className="room-card__title">{room.title}</h2>
        {room.unseenCount > 0 ? (
          <span className="pill pill--brand" aria-label={`${room.unseenCount} olästa`}>
            {room.unseenCount === 1 ? '1 ny' : `${room.unseenCount} nya`}
          </span>
        ) : null}
      </div>
      <p className="room-card__brief">{room.headline}</p>
      <p className="room-card__hint">
        {room.kind === 'personal'
          ? 'Ditt personliga minne'
          : others === 0
            ? 'Bara du'
            : others === 1
              ? 'Delad med 1 person'
              : `Delad med ${others} personer`}
      </p>
    </Link>
  );
}
