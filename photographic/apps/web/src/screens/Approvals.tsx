import { useState } from 'react';

import { Wordmark } from '../components/Wordmark.js';
import { DEMO_APPROVALS, type ApprovalItem } from '../data/demo.js';

/**
 * A calm feed of approval cards — light and fast to clear, never an inbox to dread.
 * Accept and dismiss both remove the card from local state (demo until REST lands).
 */
export function Approvals() {
  const [items, setItems] = useState<ApprovalItem[]>(DEMO_APPROVALS);

  function remove(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
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
                  onClick={() => remove(item.id)}
                >
                  Godkänn
                </button>
                <button type="button" className="btn" onClick={() => remove(item.id)}>
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
