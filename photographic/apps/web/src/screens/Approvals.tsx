import { useEffect, useState } from 'react';

import { isDemoMode, resolveProposal } from '../api/index.js';
import { CalmState, LoadingState } from '../components/CalmState.js';
import { Wordmark } from '../components/Wordmark.js';
import { approvalAudience, approvalLead } from '../data/approvals.js';
import { DEMO_APPROVALS, type ApprovalItem } from '../data/demo.js';
import { calmErrorMessage, loadApprovalsFromApi } from '../data/load.js';
import { setPendingApprovals } from '../hooks/usePendingApprovals.js';
import { useRoomData } from '../hooks/useRoomData.js';

/**
 * The queue, as a set of decisions rather than a set of notifications.
 *
 * Two things this screen owes the person. It has to say what accepting will actually do,
 * because "spara" over a request to put something in front of three colleagues is a
 * false statement. And it has to report the truth about whether the answer landed: it
 * used to remove the card and swallow the error, so a failed approval looked exactly
 * like a successful one, and an app that reports state it has not verified is a worse
 * gate than none — the person stops checking.
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
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);

  // The rail badge and the notices elsewhere read the same queue, so they move with this
  // screen rather than a page load behind it.
  useEffect(() => {
    setPendingApprovals(items);
  }, [items]);

  async function resolve(id: string, accept: boolean) {
    if (busy) return;
    setFailed(null);

    if (isDemoMode()) {
      setItems((current) => current.filter((item) => item.id !== id));
      return;
    }

    setBusy(id);
    try {
      await resolveProposal(id, accept);
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (error) {
      // The card stays. A decision the server never heard is a decision that has not
      // been made, and the person is the only one who can make it again.
      setFailed({ id, message: calmErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="page page--approvals">
      <header className="page-head">
        <Wordmark />
        <h1 className="page-head__title">Godkänn</h1>
        <p className="page-head__lede">
          Det här är sådant Photographic inte avgjorde åt dig. Tills du svarar är det inte
          sparat, och ingen modell kan läsa det.
        </p>
      </header>

      {items.length === 0 ? (
        <p className="section-block__empty">Inget väntar på dig just nu.</p>
      ) : (
        <ul className="approval-feed">
          {items.map((item) => {
            const audience = approvalAudience(item);
            return (
              <li key={item.id} className="approval-card card">
                <p className="approval-card__lead">
                  {approvalLead(item)}{' '}
                  <em className="approval-card__quote">{item.body}</em>
                </p>
                <p className="approval-card__why meta">{item.reason}</p>
                {/*
                  Who will be able to read it. The one fact a person needs to answer a
                  sharing question, and the queue never used to carry it.
                */}
                {audience ? <p className="approval-card__audience">{audience}</p> : null}
                {failed?.id === item.id ? (
                  <p className="approval-card__failed" role="alert">
                    {failed.message} Förslaget står kvar — försök igen.
                  </p>
                ) : null}
                <div className="approval-card__actions">
                  <button
                    type="button"
                    className="btn btn--brand"
                    disabled={busy === item.id}
                    onClick={() => void resolve(item.id, true)}
                  >
                    {busy === item.id ? 'Sparar…' : 'Godkänn'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === item.id}
                    onClick={() => void resolve(item.id, false)}
                  >
                    Avfärda
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
