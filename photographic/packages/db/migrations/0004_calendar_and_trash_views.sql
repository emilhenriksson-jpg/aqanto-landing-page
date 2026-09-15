-- ---------------------------------------------------------------------------
-- The calendar and the trash, as views over the log
--
-- The scope says the calendar is a view on top of an append-only event log, and that a
-- deleted memory follows the thirty-day trash rules. Those were two claims about the
-- architecture that the code did not yet make true: the trash was `app.item.status` plus
-- five columns recording who deleted it, from which client and why -- every one of which
-- the log already knew.
--
-- Two records of the same fact is one record and one thing that drifts from it, and the
-- one that drifts is always the mutable one. You find out they disagree when a person
-- sees something in the trash they restored last week.
--
-- So both are views now. Nothing here stores anything.
--
-- One piece of written-down state survives on purpose: `app.item.purge_after`. Migration
-- 0002 argued that the deadline has to be recorded rather than computed, so extending
-- retention later cannot resurrect something a person was told would be gone. That is
-- still right -- it is a decision taken at the moment of deletion, which is the kind of
-- thing a log records and a view does not recompute.
--
-- Both views are as wide as the tables they read. Callers scope to
-- `app.accessible_room_ids`, because authorisation lives in the API layer by decision
-- (build-plan 4) and the inert RLS policies were removed in 0003 rather than revived.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The calendar
-- ---------------------------------------------------------------------------

/*
 * The eight things that can happen to a memory, named the way a person reads them.
 *
 * `item.created` splits three ways, and the third is the interesting one. A creation in
 * the personal room is "sparat privat"; anywhere else is "sparat i rum"; and a creation
 * that supersedes an existing memory is a *correction* -- the case the scope describes as
 * 15 oktober becoming 1 november. Calling that one "saved" would lose both the original
 * value and the fact that anything changed, which is the single thing the log exists to
 * prevent.
 *
 * `body` comes from the payload and not from `app.item`, and that is the difference
 * between a log and a join. The item knows what the memory says now. The event knows what
 * it said that day, which is what a day is a record of.
 */
CREATE OR REPLACE VIEW app.memory_event AS
SELECT
  e.seq,
  e.occurred_at,
  e.room_id,
  r.title AS room_title,
  r.kind  AS room_kind,
  e.event_type,
  CASE
    WHEN e.event_type = 'item.created' AND e.payload ? 'supersedes' THEN 'updated'
    WHEN e.event_type = 'item.created' AND r.kind = 'personal'      THEN 'saved_private'
    WHEN e.event_type = 'item.created'                              THEN 'saved_to_room'
    WHEN e.event_type IN ('item.updated', 'item.superseded')        THEN 'updated'
    WHEN e.event_type = 'item.shared'                               THEN 'shared'
    WHEN e.event_type = 'item.moved'                                THEN 'moved'
    WHEN e.event_type = 'item.deleted'                              THEN 'deleted'
    WHEN e.event_type = 'item.restored'                             THEN 'restored'
    WHEN e.event_type = 'item.disputed'                             THEN 'disputed'
  END AS kind,
  nullif(e.payload ->> 'item_id', '')::uuid AS item_id,
  e.payload ->> 'short_id'    AS short_id,
  e.payload ->> 'kind'        AS item_kind,
  e.payload ->> 'body'        AS body,
  e.payload ->> 'previous'    AS previous_body,
  e.payload -> 'shared_with'  AS shared_with,
  e.payload -> 'disputes'     AS disputes,
  coalesce((e.payload ->> 'redacted')::boolean, false) AS redacted,
  e.actor_person_id,
  p.display_name AS actor_name,
  e.agent_client,
  e.client_id,
  e.session_ref,
  e.approved_by IS NOT NULL AS was_approved,
  e.motivation,
  e.explicit,
  e.source_kind,
  e.source_label,
  e.source_ref,
  e.source_uri,
  e.from_room_id,
  fr.title AS from_room_title,
  e.to_room_id,
  tr.title AS to_room_title
FROM app.event e
JOIN app.room r ON r.id = e.room_id
LEFT JOIN app.person p ON p.id = e.actor_person_id
LEFT JOIN app.room fr ON fr.id = e.from_room_id
LEFT JOIN app.room tr ON tr.id = e.to_room_id
WHERE e.event_type IN (
  'item.created',
  'item.updated',
  'item.superseded',
  'item.shared',
  'item.moved',
  'item.deleted',
  'item.restored',
  'item.disputed'
);

COMMENT ON VIEW app.memory_event IS
  'The calendar. One row per memory event, named as the person reads it. Scope to app.accessible_room_ids.';

-- ---------------------------------------------------------------------------
-- The trash
-- ---------------------------------------------------------------------------

/*
 * What is in the trash is a question about the log: an item whose most recent lifecycle
 * event was a deletion, and which has not been restored or purged since.
 *
 * Deriving it fixes a class of bug rather than one bug. A delete-undo-delete sequence has
 * one answer here and cannot have two.
 *
 * The text and the deadline come from `app.item`, because the item is the memory's
 * current value and the deadline is a decision rather than a derivation. Everything about
 * *who* deleted it, *from which client* and *why* comes from the event, where it was
 * always recorded and where nothing can overwrite it.
 */
CREATE OR REPLACE VIEW app.trash AS
WITH last_lifecycle AS (
  SELECT DISTINCT ON (nullif(e.payload ->> 'item_id', '')::uuid)
    nullif(e.payload ->> 'item_id', '')::uuid AS item_id,
    e.seq,
    e.event_type,
    e.occurred_at,
    e.actor_person_id,
    e.agent_client,
    e.motivation
  FROM app.event e
  WHERE e.event_type IN ('item.deleted', 'item.restored', 'item.purged')
    AND e.payload ? 'item_id'
  ORDER BY nullif(e.payload ->> 'item_id', '')::uuid, e.seq DESC
)
SELECT
  i.id AS item_id,
  i.short_id,
  i.room_id,
  r.title AS room_title,
  i.kind,
  i.body,
  i.author_person_id,
  l.seq AS deleted_seq,
  l.occurred_at AS deleted_at,
  l.actor_person_id AS deleted_by,
  l.agent_client AS deleted_by_client,
  l.motivation AS delete_reason,
  i.purge_after
FROM last_lifecycle l
JOIN app.item i ON i.id = l.item_id
JOIN app.room r ON r.id = i.room_id
WHERE l.event_type = 'item.deleted'
  AND i.purge_after IS NOT NULL;

COMMENT ON VIEW app.trash IS
  'The 30-day trash, derived from the log. Scope to app.accessible_room_ids.';

-- ---------------------------------------------------------------------------
-- The activity feed learns the event types that were missing from it
-- ---------------------------------------------------------------------------

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
  i.status           AS item_status,
  e.motivation,
  e.explicit,
  e.client_id,
  e.from_room_id,
  e.to_room_id
FROM app.event e
JOIN app.room r ON r.id = e.room_id
LEFT JOIN app.person p ON p.id = e.actor_person_id
LEFT JOIN app.item i ON i.id = nullif(e.payload ->> 'item_id', '')::uuid
WHERE e.event_type IN (
  'item.created',
  'item.updated',
  'item.superseded',
  'item.shared',
  'item.moved',
  'item.deleted',
  'item.restored',
  'item.purged',
  'item.disputed',
  'item.dispute_resolved',
  'proposal.created',
  'proposal.accepted',
  'proposal.rejected',
  'document.uploaded',
  'room.created',
  'member.joined',
  'member.left'
);
