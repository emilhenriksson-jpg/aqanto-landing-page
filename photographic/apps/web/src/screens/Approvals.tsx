import { useState } from 'react';

import { isDemoMode, resolveProposal } from '../api/index.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { DEMO_APPROVALS, type ApprovalItem } from '../data/demo.js';
import { loadApprovalsFromApi } from '../data/load.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * A calm feed of approval cards — light and fast to clear, never an inbox to dread.
 * Accept and dismiss remove the card locally; live mode also POSTs the resolve.
 */
export function Approvals() {
  const state = useRoomData(
    'approvals',
    () => DEMO_APPROVALS,
    () => loadApprovalsFromApi(),
  );

  if (state.status === 'loading') return <LoadingState label="Hämtar förslag…" />;
  if (state.status === 'error') {
    return <CalmState title="Godkänn" message={state.message} />;
  }

  return <ApprovalsReady initial={state.data} />;
}

function ApprovalsReady({ initial }: { initial: ApprovalItem[] }) {
  const [items, setItems] = useState<ApprovalItem[]>(initial);

  async function resolve(id: string, accept: boolean) {
    setItems((current) => current.filter((item) => item.id !== id));
    if (isDemoMode()) return;
    try {
      await resolveProposal(id, accept);
    } catch {
      // Card already cleared locally; network resolve is best-effort.
    }
  }

  return (
    <article className="page page--approvals">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">Godkänn</h1>
        <p className="page-head__lede">
          Något vill sparas. Ett tryck räcker — godkänn eller avfärda, sen är det klart.
        </p>
      </header>

      {items.length === 0 ? (
        <p className="section-block__empty">Inget att godkänna just nu.</p>
      ) : (
        <ul className="approval-feed">
          {items.map((item) => (
            <li key={item.id} className="approval-card card">
              <p className="approval-card__lead">
                {item.clientLabel} vill spara:{' '}
                <em className="approval-card__quote">{item.body}</em>
              </p>
              <p className="approval-card__why meta">
                Föreslaget av {item.clientLabel}. {item.reason}
              </p>
              <div className="approval-card__actions">
                <button
                  type="button"
                  className="btn btn--brand"
                  onClick={() => void resolve(item.id, true)}
                >
                  Godkänn
                </button>
                <button type="button" className="btn" onClick={() => void resolve(item.id, false)}>
                  Avfärda
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
