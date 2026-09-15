-- ---------------------------------------------------------------------------
-- Letting a personal room actually be deleted.
--
-- This migration widens the append-only guarantee on `app.event`. It is in its own file,
-- with this name, because that is not something anyone should discover inside a
-- migration called "export and deletion".
--
-- The problem, found by writing the deletion and running it: `app.event.room_id`
-- references `app.room` with ON DELETE CASCADE, and the append-only trigger refuses
-- DELETE. So `DELETE FROM app.room` on a personal room raises
-- `app.event is append-only (attempted DELETE)` and permanent account deletion is not
-- implementable at all. Not "awkward" — impossible. It is exactly the thing that cannot
-- be retrofitted cheaply, which is why building deletion early was worth doing.
--
-- Three ways out, and why this is the one:
--
--   1. Drop the cascade and orphan the events. Then a deleted person's log lines sit in
--      a table forever pointing at a room that does not exist, and every read path has
--      to learn about a state that should not exist.
--   2. Redact instead of delete, as `purge_expired_items` does for trashed items. That
--      keeps the room row and the event rows and strips the text. It is defensible for
--      the trash — the audit trail of *what happened* is worth keeping — but not here:
--      the whole promise of account deletion is that the personal room is gone, and a
--      room row with a name and a creation date, referencing a tombstone, is not gone.
--   3. Permit DELETE from inside one function, for one room, under a session flag that
--      the function always clears. Which is precisely the shape 0002 already chose when
--      it needed the same kind of hole for redaction, so this is an extension of an
--      existing pattern rather than a new one.
--
-- What keeps the hole narrow:
--
--   - The flag is set with `set_config(..., true)`, so it is transaction-local and
--     cannot outlive the statement that set it, let alone the connection.
--   - `app.erase_personal_room` is the only thing that sets it, and it clears it before
--     returning on every path.
--   - It refuses any room that is not a `personal` room created by the person named. A
--     shared room's history belongs to its members and is not reachable through here.
--   - UPDATE remains permitted only under the redaction flag from 0002. Neither flag
--     grants the other.
--
-- NOTE FOR THE EVENT-LOG TRACK: this changes a guarantee you own. The invariant is now
-- "append-only except from inside `app.purge_expired_items` (UPDATE) and
-- `app.erase_personal_room` (DELETE)". If you reorganise the trigger, both hatches have
-- to survive or account deletion breaks.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.reject_event_mutation() RETURNS trigger AS $$
BEGIN
  -- Redaction during a purge. From 0002, unchanged: strips text from a payload while
  -- keeping the shape, so the feed can still say something was removed.
  IF TG_OP = 'UPDATE' AND coalesce(current_setting('app.redacting', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;

  -- Erasure of a personal room during account deletion. DELETE only, and only under a
  -- flag that `app.erase_personal_room` sets and clears around a single statement.
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.erasing', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'app.event is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

/*
 * Deletes one person's personal room and everything that cascades from it.
 *
 * Items, documents, chunks, briefs, read state and events all reference `app.room` with
 * ON DELETE CASCADE, so this one statement is the whole erasure — which is also why it
 * needs the hatch above.
 *
 * Returns the number of events removed, so the deletion record can evidence it. An
 * erasure nobody can show ran is not much of an erasure, and this is the one operation
 * that cannot be repeated to check.
 *
 * Refuses anything that is not the named person's own personal room. The guard is the
 * reason this function is safe to exist: without it, a caller with a room id would have
 * a way to delete a shared room's history, and the flag would be a general-purpose hole
 * rather than a specific one.
 */
CREATE OR REPLACE FUNCTION app.erase_personal_room(p_person_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_room_id uuid;
  v_events  integer;
BEGIN
  SELECT id INTO v_room_id
  FROM app.room
  WHERE created_by = p_person_id AND kind = 'personal';

  IF v_room_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT count(*)::integer INTO v_events FROM app.event WHERE room_id = v_room_id;

  -- Transaction-local, and cleared below on every path. A flag that could outlive this
  -- function would turn the append-only log into an ordinary table for whatever ran
  -- next on the same connection.
  PERFORM set_config('app.erasing', 'on', true);

  BEGIN
    DELETE FROM app.room WHERE id = v_room_id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.erasing', 'off', true);
    RAISE;
  END;

  PERFORM set_config('app.erasing', 'off', true);

  RETURN v_events;
END;
$$;

COMMENT ON FUNCTION app.erase_personal_room IS
  'The only code permitted to DELETE from app.event. Personal rooms only, by owner.';
