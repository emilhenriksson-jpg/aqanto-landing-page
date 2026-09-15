-- ---------------------------------------------------------------------------
-- Trash, purge, and the activity feed
--
-- A model deleting the wrong memory is the failure that loses the user, so nothing
-- is ever removed on the spot. `forget` moves an item to the trash, where it stays
-- visible and restorable for 30 days and is then genuinely gone.
--
-- "Genuinely gone" forces a decision the first migration left open. Deleting the
-- `item` row is not erasure if the same text is still sitting in an `app.event`
-- payload, and `app.event` is append-only by trigger. Two ways out: forbid memory
-- text in event payloads, or allow a narrow redaction path.
--
-- This takes the second. Forbidding text in payloads would make the log useless for
-- rebuilding projections, and would require every write path to be careful about
-- something invisible at the call site. Instead the trigger keeps rejecting every
-- UPDATE except from inside `app.purge_expired_items`, which sets a session flag it
-- always clears. DELETE on the log stays impossible. So the log remains append-only
-- for all ordinary purposes, the audit trail of *what happened* survives a purge, and
-- only the text itself is redacted.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Trash columns
-- ---------------------------------------------------------------------------

ALTER TABLE app.item
  ADD COLUMN deleted_at        timestamptz,
  ADD COLUMN deleted_by        uuid REFERENCES app.person (id),
  ADD COLUMN deleted_by_client text,
  -- When the row stops being recoverable. Stored rather than computed so extending
  -- retention later cannot retroactively resurrect something a person expected gone.
  ADD COLUMN purge_after       timestamptz,
  ADD COLUMN delete_reason     text,
  -- Lets the model offer "say undo" immediately after deleting, without the person
  -- having to open the app.
  ADD COLUMN undo_token        text;

COMMENT ON COLUMN app.item.purge_after IS
  'Hard-delete deadline. NULL for anything not in the trash.';

-- The trash listing, newest first, per room.
CREATE INDEX item_trash_idx ON app.item (room_id, deleted_at DESC)
  WHERE status = 'deleted';

-- The purge sweep. Partial so it stays small no matter how much is in the trash.
CREATE INDEX item_purge_due_idx ON app.item (purge_after)
  WHERE status = 'deleted' AND purge_after IS NOT NULL;

CREATE UNIQUE INDEX item_undo_token_idx ON app.item (undo_token)
  WHERE undo_token IS NOT NULL;

-- A deleted row must carry its deadline, and a live row must not. Without this the
-- purge sweep silently skips rows and the trash grows forever.
ALTER TABLE app.item
  ADD CONSTRAINT item_trash_consistent CHECK (
    (status = 'deleted' AND deleted_at IS NOT NULL AND purge_after IS NOT NULL)
    OR (status <> 'deleted' AND deleted_at IS NULL AND purge_after IS NULL)
  );

-- ---------------------------------------------------------------------------
-- The redaction escape hatch
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.reject_event_mutation() RETURNS trigger AS $$
BEGIN
  -- Redaction during a purge is the only permitted mutation, and only for UPDATE.
  -- `true` as the second argument makes current_setting return NULL rather than
  -- raising when the flag was never set, which is the normal case.
  IF TG_OP = 'UPDATE' AND coalesce(current_setting('app.redacting', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'app.event is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Purge
-- ---------------------------------------------------------------------------

/*
 * Hard-deletes everything whose retention has run out, and redacts the deleted text
 * from the event log so the promise the trash makes is actually kept.
 *
 * Returns the number of items purged. Safe to call repeatedly; the `limit` keeps a
 * single run bounded so a large backlog cannot hold a transaction open.
 */
CREATE OR REPLACE FUNCTION app.purge_expired_items(p_limit integer DEFAULT 500)
RETURNS integer AS $$
DECLARE
  v_ids   uuid[];
  v_count integer;
BEGIN
  SELECT array_agg(id) INTO v_ids
  FROM (
    SELECT id FROM app.item
    WHERE status = 'deleted'
      AND purge_after IS NOT NULL
      AND purge_after <= now()
    ORDER BY purge_after
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) due;

  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM set_config('app.redacting', 'on', true);

  -- Strip the text but keep the shape, so the activity feed can still say that
  -- something was remembered and then removed, without saying what it was.
  UPDATE app.event
  SET payload = (payload - 'body' - 'text' - 'structured' - 'excerpt')
                || jsonb_build_object('redacted', true, 'redacted_at', now())
  WHERE payload ? 'item_id'
    AND (payload ->> 'item_id')::uuid = ANY (v_ids);

  PERFORM set_config('app.redacting', 'off', true);

  DELETE FROM app.item WHERE id = ANY (v_ids);

  v_count := array_length(v_ids, 1);
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION app.purge_expired_items IS
  'Called by the purge_trash job. The only code permitted to mutate app.event.';

-- ---------------------------------------------------------------------------
-- The activity feed
-- ---------------------------------------------------------------------------

/*
 * History has to be cheap, because it is on a screen people open casually. The event
 * log already holds everything; this index is what makes "what happened to my memory,
 * newest first" a range scan instead of a sort over the whole log.
 */
CREATE INDEX event_person_recent_idx ON app.event (actor_person_id, occurred_at DESC)
  WHERE actor_person_id IS NOT NULL;

/*
 * Only the event types a person should see. Job bookkeeping and projection rebuilds
 * are noise: showing them would bury the two lines that actually matter.
 */
CREATE OR REPLACE VIEW app.activity AS
SELECT
  e.seq,
  e.room_id,
  r.title            AS room_title,
  r.kind             AS room_kind,
  e.event_type,
  e.payload,
  e.actor_person_id,
  p.display_name     AS actor_name,
  e.agent_client,
  e.approved_by IS NOT NULL AS was_approved,
  e.occurred_at,
  i.short_id,
  i.body,
  i.status           AS item_status
FROM app.event e
JOIN app.room r ON r.id = e.room_id
LEFT JOIN app.person p ON p.id = e.actor_person_id
LEFT JOIN app.item i ON i.id = nullif(e.payload ->> 'item_id', '')::uuid
WHERE e.event_type IN (
  'item.created',
  'item.updated',
  'item.superseded',
  'item.deleted',
  'item.restored',
  'item.purged',
  'proposal.created',
  'proposal.accepted',
  'proposal.rejected',
  'document.uploaded',
  'room.created',
  'member.joined',
  'member.left'
);

COMMENT ON VIEW app.activity IS
  'User-facing history. Callers must still scope to app.accessible_room_ids.';
