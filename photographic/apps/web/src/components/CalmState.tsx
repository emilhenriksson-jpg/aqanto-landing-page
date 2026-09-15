import { Link } from 'react-router-dom';

import { Wordmark } from './Wordmark.js';

/** Calm Swedish empty / error surface — never a crash, never a stack trace. */
export function CalmState({
  title,
  message,
  backToRooms = false,
}: {
  title?: string;
  message: string;
  backToRooms?: boolean;
}) {
  return (
    <article className="page page--calm">
      <header className="page-head">
        <Wordmark />
        {title ? <h1 className="page-head__title">{title}</h1> : null}
        <p className="page-head__lede">{message}</p>
      </header>
      {backToRooms ? (
        <p className="section-block__empty">
          <Link to="/rum">Tillbaka till rum</Link>
        </p>
      ) : null}
    </article>
  );
}

export function LoadingState({ label = 'Hämtar…' }: { label?: string }) {
  return (
    <article className="page page--calm" aria-busy="true">
      <p className="section-block__empty">{label}</p>
    </article>
  );
}
