import { useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';

import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { loadInvitePreview, type InvitePreviewData } from '../data/demo.js';
import { loadInviteFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * Invite landing — what a recipient sees before they have an account.
 * Outside the shell rail: full-bleed, calm, one violet CTA. No signup wall.
 */
export function InvitePreview() {
  const { token = '' } = useParams();
  if (!token) return <Navigate to="/" replace />;

  const state = useRoomData(
    `invite:${token}`,
    () => loadInvitePreview(token),
    () => loadInviteFromApi(token),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar inbjudan…" />;
  if (state.status === 'error') {
    return <CalmState title="Inbjudan" message={state.message} />;
  }
  if (!state.data) {
    return <CalmState title="Inbjudan" message="Inbjudan finns inte." />;
  }

  return <InviteReady invite={state.data} />;
}

function InviteReady({ invite }: { invite: InvitePreviewData }) {
  const [joined, setJoined] = useState(false);

  if (joined) {
    return (
      <div className="invite">
        <article className="invite__page invite__page--joined">
          <Wordmark large />
          <p className="invite__confirm" role="status">
            Du är med i {invite.roomTitle}.
          </p>
        </article>
      </div>
    );
  }

  return (
    <div className="invite">
      <article className="invite__page">
        <header className="invite__hero">
          <Wordmark large />
          <p className="invite__from meta">
            {invite.invitedByName} har bjudit in dig
          </p>
          <h1 className="invite__title">{invite.roomTitle}</h1>
          {invite.brief ? <p className="invite__brief">{invite.brief}</p> : null}
        </header>

        {invite.lines.length > 0 ? (
          <section className="invite__content" aria-label="Ur rummet">
            <ul className="invite__lines">
              {invite.lines.map((line) => (
                <li key={line.shortId} className="invite__line">
                  <p className="invite__line-body">{line.body}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="invite__empty meta">Inget sparat i rummet ännu.</p>
        )}

        <footer className="invite__cta">
          <button
            type="button"
            className="btn btn--brand invite__join"
            onClick={() => setJoined(true)}
          >
            Gå med
          </button>
        </footer>
      </article>
    </div>
  );
}
