-- ---------------------------------------------------------------------------
-- 0021 — one trash, for memories and for documents
-- ---------------------------------------------------------------------------

/*
 * `app.trash` becomes a union over both lifecycle event streams.
 *
 * Documents arrived with their own `deleted_at`/`purge_after` and their own listing, which
 * was the right call at the time: this view derives membership from item lifecycle *events*,
 * and the transactional path that guarantees those events exist was still in flight. It is
 * the wrong call now that it has landed. A person who deleted something goes looking in one
 * place, and a thirty-day promise that behaves differently for a file than for a memory is a
 * promise with a footnote. Two surfaces would also drift the way two copies of anything in
 * this repo have drifted.
 *
 * Both halves are derived the same way — the most recent lifecycle event per thing — rather
 * than one from the log and one from a column. That is what makes delete-undo-delete have one
 * answer for a document as it already does for a memory, and it is why `document.deleted`
 * being written inside the same transaction as the row update was the prerequisite for this
 * migration rather than a detail of it.
 *
 * `entry_type` is the discriminator. It is not called `kind`, because `kind` already means
 * `app.item_kind` on the memory half and two columns called almost the same thing is how a
 * caller reaches for the wrong one. The columns that only one half has are NULL on the other,
 * which the mapping layer turns into a proper discriminated union.
 */

DROP VIEW IF EXISTS app.trash;

CREATE VIEW app.trash AS
WITH item_lifecycle AS (
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
),
document_lifecycle AS (
  SELECT DISTINCT ON (nullif(e.payload ->> 'document_id', '')::uuid)
    nullif(e.payload ->> 'document_id', '')::uuid AS document_id,
    e.seq,
    e.event_type,
    e.occurred_at,
    e.actor_person_id,
    e.agent_client,
    e.motivation
  FROM app.event e
  WHERE e.event_type IN ('document.deleted', 'document.restored', 'document.purged')
    AND e.payload ? 'document_id'
  ORDER BY nullif(e.payload ->> 'document_id', '')::uuid, e.seq DESC
)
SELECT
  'memory'::text        AS entry_type,
  i.id                  AS item_id,
  NULL::uuid            AS document_id,
  i.short_id,
  NULL::text            AS filename,
  NULL::bigint          AS byte_size,
  i.room_id,
  r.title               AS room_title,
  i.kind::text          AS kind,
  i.body,
  i.author_person_id,
  l.seq                 AS deleted_seq,
  l.occurred_at         AS deleted_at,
  l.actor_person_id     AS deleted_by,
  l.agent_client        AS deleted_by_client,
  l.motivation          AS delete_reason,
  i.purge_after
FROM item_lifecycle l
JOIN app.item i ON i.id = l.item_id
JOIN app.room r ON r.id = i.room_id
WHERE l.event_type = 'item.deleted'
  AND i.purge_after IS NOT NULL

UNION ALL

SELECT
  'document'::text      AS entry_type,
  NULL::uuid            AS item_id,
  d.id                  AS document_id,
  NULL::text            AS short_id,
  d.filename,
  d.byte_size,
  d.room_id,
  r.title               AS room_title,
  NULL::text            AS kind,
  -- The filename is what a person recognises a deleted file by. The extracted text is not
  -- put here: it can be megabytes, and a trash listing is a list of things rather than a
  -- read of their contents.
  NULL::text            AS body,
  d.uploaded_by         AS author_person_id,
  l.seq                 AS deleted_seq,
  l.occurred_at         AS deleted_at,
  l.actor_person_id     AS deleted_by,
  l.agent_client        AS deleted_by_client,
  l.motivation          AS delete_reason,
  d.purge_after
FROM document_lifecycle l
JOIN app.document d ON d.id = l.document_id
JOIN app.room r ON r.id = d.room_id
WHERE l.event_type = 'document.deleted'
  AND d.purge_after IS NOT NULL;

COMMENT ON VIEW app.trash IS
  'The 30-day trash for memories and documents together, derived from the log. Scope to app.accessible_room_ids.';

-- The view is read by the application role like every other one.
GRANT SELECT ON app.trash TO photographic_app;
