import { useEffect, useState } from 'react';

import { isDemoMode } from '../api/config.js';
import { DEMO_APPROVALS, type ApprovalItem } from '../data/demo.js';
import { loadApprovalsFromApi } from '../data/load.js';

/**
 * The pending queue, shared by every screen that needs to mention it.
 *
 * A module-level store rather than a hook per component, for two reasons. The rail is
 * mounted on every route and the notice on three of them, so a per-component fetch would
 * ask the same question four times on one page load. And when a card is answered on
 * `Godkänn` the badge has to go down in the same instant — a count that lags the decision
 * that changed it is worse than no count, because it teaches the person that the number
 * is decoration.
 */

type Listener = (items: ApprovalItem[] | null) => void;

/**
 * `null` is "we do not know", and it is deliberately not `[]`.
 *
 * Signed out, offline, or an API having a bad minute all land here, and none of them
 * mean nothing is waiting. Reporting an empty queue on a failed read is the exact
 * failure this feature exists to undo, so unknown renders as nothing at all.
 */
let cache: ApprovalItem[] | null = null;
let asked = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<Listener>();

function publish(): void {
  for (const listener of listeners) listener(cache);
}

/** Replace the queue, e.g. after a card was answered. Notifies every screen at once. */
export function setPendingApprovals(items: ApprovalItem[]): void {
  cache = items;
  asked = true;
  publish();
}

/** Forget what we know, so the next mount asks again. Used by tests. */
export function resetPendingApprovals(): void {
  cache = null;
  asked = false;
  inFlight = null;
}

function refresh(): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      cache = isDemoMode() ? DEMO_APPROVALS : await loadApprovalsFromApi();
    } catch {
      cache = null;
    } finally {
      asked = true;
      inFlight = null;
      publish();
    }
  })();

  return inFlight;
}

export function usePendingApprovals(): ApprovalItem[] | null {
  const [items, setItems] = useState<ApprovalItem[] | null>(cache);

  useEffect(() => {
    listeners.add(setItems);
    setItems(cache);
    // Asked once per page load, not once per navigation: a failed read must not turn
    // every route change into another request.
    if (!asked) void refresh();
    return () => {
      listeners.delete(setItems);
    };
  }, []);

  return items;
}
