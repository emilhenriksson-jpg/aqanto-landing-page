import { Link } from 'react-router-dom';

import {
  approvalAudience,
  approvalLead,
  remainingLabel,
  waitingConsequence,
  waitingHeading,
} from '../data/approvals.js';
import type { ApprovalItem } from '../data/demo.js';
import { usePendingApprovals } from '../hooks/usePendingApprovals.js';

/**
 * A waiting decision, on the screen the person is already standing on.
 *
 * The approval gate is the reason automatic memory is trustworthy rather than alarming,
 * and until now nothing told anyone it had stopped something. Proposals piled up unseen,
 * the AI looked like it had forgotten, and the conclusion a person reaches from that is
 * that the product does not work — not that it is waiting for them.
 *
 * So it appears where they already are, and it is honest rather than loud: what is
 * waiting, why a person rather than the router has to decide it, and what the silence
 * has been costing. One notice, never a modal, gone the moment the queue is empty.
 */
export function PendingApprovals({ roomId }: { roomId?: string } = {}) {
  const pending = usePendingApprovals();
  if (!pending || pending.length === 0) return null;

  // Inside a room, only that room's decisions — the rail carries the global count, and a
  // notice about the kitchen renovation on top of the board room is noise.
  const items = roomId ? pending.filter((item) => item.roomId === roomId) : pending;
  if (items.length === 0) return null;

  const [first] = items as [ApprovalItem, ...ApprovalItem[]];
  const audience = approvalAudience(first);
  const rest = remainingLabel(items.length);

  return (
    <aside className="waiting card" aria-labelledby="waiting-title">
      <p className="waiting__eyebrow meta">Väntar på dig</p>
      <h2 className="waiting__title" id="waiting-title">
        {waitingHeading(items.length)}
      </h2>

      <p className="waiting__lead">
        {approvalLead(first)} <em className="waiting__quote">{first.body}</em>
      </p>
      <p className="waiting__why meta">
        {first.reason}
        {audience ? ` ${audience}` : ''}
      </p>

      <p className="waiting__cost">{waitingConsequence(items.length)}</p>
      {rest ? <p className="waiting__rest meta">{rest}</p> : null}

      <Link className="btn btn--brand waiting__action" to="/godkann">
        {items.length === 1 ? 'Svara' : 'Svara på alla'}
      </Link>
    </aside>
  );
}
