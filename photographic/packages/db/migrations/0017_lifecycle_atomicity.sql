-- ---------------------------------------------------------------------------
-- 0017 — what the write path needs to be atomic
-- ---------------------------------------------------------------------------

/*
 * Two additions, both in service of the same promise: the log is the truth, and a
 * half-finished operation must not be able to make it a half-truth.
 *
 * Renumbered from 0016 on merge: `main` had gained `0016_app_role_grants.sql` in the
 * meantime, and that one is already applied to production, so this is the file that
 * moves. Filename order is what the runner sorts on and the ledger keys on, so two
 * files sharing a number is deterministic but unreadable — and renaming an *applied*
 * migration re-runs it, which is why the unapplied one renumbers and never the other
 * way round.
 *
 * No ordering dependency either way: nothing here touches a table another track is
 * mid-change on. `app.proposal.intent` is a check constraint added in 0003, and
 * `app.account_deletion` came in with 0013.
 */

-- ---------------------------------------------------------------------------
-- A move is its own intent
-- ---------------------------------------------------------------------------

/*
 * Approving a queued move has to relocate the memory. While `move` shared the `share`
 * intent, saying yes to "flytta p-7k2m till Buyersclub Ledning" ran the share path: the
 * original stayed where it was and a *copy* appeared in the target room. The person got
 * something they did not ask for, in a room other people read, and the short id they had
 * been told to use still pointed at the old one.
 *
 * The constraint is replaced rather than widened in place because that is all Postgres
 * offers for a CHECK. `proposal_needs_source` already covers the other half — a move with
 * no `source_item` is a proposal that cannot be accepted — and `move` is included in it by
 * the same `intent = 'remember' OR source_item IS NOT NULL` shape.
 */
ALTER TABLE app.proposal
  DROP CONSTRAINT IF EXISTS proposal_intent_known;

ALTER TABLE app.proposal
  ADD CONSTRAINT proposal_intent_known
    CHECK (intent IN ('remember', 'share', 'update', 'move'));

-- ---------------------------------------------------------------------------
-- Account deletion becomes resumable
-- ---------------------------------------------------------------------------

/*
 * Deleting an account is a dozen SQL statements and two sets of object-storage deletions
 * that cannot share a transaction with them. Without a record of how far it got, a crash in
 * the middle left a person half deleted and the next timer run unable to tell what had
 * already happened — redo the blobs, redo the counts, and no way to know whether the
 * personal room had been erased or was simply empty.
 *
 * `progress` is that record: one `step:<name>` flag per step plus the counts each step
 * produced, written in the same transaction as the step's own SQL. It becomes `removed`
 * when the deletion completes, so a deletion that took three attempts still reports one
 * account of what it removed.
 *
 * `claimed_at` is a lease and not a lock, so recovery needs no human: two overlapping
 * sweeps cannot both start on one person, and a sweep that died stops being current on its
 * own rather than leaving the deletion stuck behind a flag somebody has to clear.
 */
ALTER TABLE app.account_deletion
  ADD COLUMN progress   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN claimed_at timestamptz;

COMMENT ON COLUMN app.account_deletion.progress IS
  'Which sweep steps have run and what each removed. Written with the step, so a resumed sweep skips what is done.';
COMMENT ON COLUMN app.account_deletion.claimed_at IS
  'Lease held by the sweep currently executing this deletion. Expires, so a dead worker does not strand a person.';

-- Requested, due, and not currently leased: exactly what a sweep should pick up.
CREATE INDEX account_deletion_claimable_idx
  ON app.account_deletion (execute_after)
  WHERE status = 'requested';
