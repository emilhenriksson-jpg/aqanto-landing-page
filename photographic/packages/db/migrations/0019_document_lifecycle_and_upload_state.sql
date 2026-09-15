-- ---------------------------------------------------------------------------
-- Documents get a life cycle, and an upload gets a state that survives a crash.
--
-- Two holes, one shape. Uploading a document writes the bytes and charges the person's
-- ten gigabytes *before* the document row and its chunks exist, and nothing compensated
-- if that transaction failed. So a transient error consumed part of someone's quota with
-- an object they could never see, and left an original in storage with no memory pointing
-- at it. There was also no ordinary way to delete a single document, so the person could
-- not clean it up even if they knew.
--
-- What this adds:
--
--   1. `app.blob_upload` — the reservation, written in the same transaction as the charge
--      and cleared when the document exists. A row still sitting here is an upload that
--      did not finish, which is the only durable way to know that after a restart:
--      compensation in the process cannot run if the process is what died.
--
--   2. Trash for documents, the same shape memories already have. `deleted_at`,
--      `deleted_by`, `purge_after`, thirty days, restorable, and the storage charge held
--      until the purge — because a document in the trash is still a document a person can
--      get back, and giving the quota back early would mean the restore could fail.
--
--   3. Search that stops at the trash. `app.search_chunks` is redefined to skip chunks of
--      a deleted document: a deleted memory that still turns up in search is the failure
--      the trash exists to prevent, and it would be no better for a contract.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Upload state
-- ---------------------------------------------------------------------------

/*
 * One row per storage charge that has not yet been matched by a document.
 *
 * Written inside the same transaction as `app.reserve_storage`, so the charge and the
 * record of why it was made cannot come apart. Deleted when the document row lands. What
 * is left over is therefore exactly the set of charges nobody is using, and the
 * reconciliation job can act on it without guessing.
 *
 * `person_id` and `checksum` mirror `app.storage_object`'s key, because releasing the
 * charge is what reconciliation does with this row.
 */
CREATE TABLE app.blob_upload (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  room_id      uuid NOT NULL REFERENCES app.room (id) ON DELETE CASCADE,
  checksum     text NOT NULL,
  storage_key  text NOT NULL,
  byte_size    bigint NOT NULL CHECK (byte_size >= 0),
  filename     text NOT NULL,
  -- True when these bytes were already on this person's account, so reconciliation knows
  -- not to delete an object another document of theirs is using.
  deduplicated boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The reconciliation sweep: oldest first, and only rows old enough that an upload still
-- in flight cannot be mistaken for an abandoned one.
CREATE INDEX blob_upload_age_idx ON app.blob_upload (created_at);

COMMENT ON TABLE app.blob_upload IS
  'A storage charge with no document yet. A leftover row is an upload that died mid-flight.';

-- ---------------------------------------------------------------------------
-- Document trash
-- ---------------------------------------------------------------------------

ALTER TABLE app.document
  ADD COLUMN deleted_at        timestamptz,
  ADD COLUMN deleted_by        uuid REFERENCES app.person (id),
  ADD COLUMN deleted_by_client text,
  -- Stored rather than computed, exactly as `app.item.purge_after` is: extending retention
  -- later must not retroactively resurrect something a person expected to be gone.
  ADD COLUMN purge_after       timestamptz;

COMMENT ON COLUMN app.document.purge_after IS
  'Hard-delete deadline. NULL for a document that is not in the trash.';

-- A deleted document must carry its deadline and a live one must not, or the purge sweep
-- silently skips rows and the trash grows for ever.
ALTER TABLE app.document
  ADD CONSTRAINT document_trash_consistent CHECK (
    (deleted_at IS NULL AND purge_after IS NULL)
    OR (deleted_at IS NOT NULL AND purge_after IS NOT NULL)
  );

-- Listing a room's documents, which is now a read of the live ones.
CREATE INDEX document_room_live_idx ON app.document (room_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- The trash listing and the purge sweep.
CREATE INDEX document_trash_idx ON app.document (room_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX document_purge_due_idx ON app.document (purge_after)
  WHERE deleted_at IS NOT NULL;

/*
 * Storage charges that no document accounts for.
 *
 * The other half of reconciliation, and the one that covers damage done before any of
 * this existed: a `storage_object` row whose checksum has no document — deleted or not —
 * and no upload in flight. Such a row is quota a person is paying for with nothing to
 * show, and there is no path by which a legitimate one appears here.
 *
 * Deleted documents count as accounting for their object. A document in the trash is
 * restorable for thirty days, and releasing its charge early would let the restore fail
 * at the storage limit.
 */
CREATE OR REPLACE FUNCTION app.orphaned_storage_objects(p_older_than interval, p_limit integer DEFAULT 100)
RETURNS TABLE (person_id uuid, checksum text, storage_key text, byte_size bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT o.person_id, o.checksum, o.storage_key, o.byte_size
  FROM app.storage_object o
  WHERE o.first_seen_at < now() - p_older_than
    AND NOT EXISTS (
      SELECT 1 FROM app.document d
      WHERE d.checksum = o.checksum AND d.uploaded_by = o.person_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM app.blob_upload u
      WHERE u.checksum = o.checksum AND u.person_id = o.person_id
    )
  ORDER BY o.first_seen_at
  LIMIT greatest(p_limit, 0);
$$;

COMMENT ON FUNCTION app.orphaned_storage_objects IS
  'Storage charged to a person with no document, deleted or otherwise, behind it.';

/*
 * Whether a blob is safe to delete.
 *
 * Content addressing means one object can be referenced by several people's documents and
 * several people's ledger rows. Deleting it because *this* person no longer needs it would
 * break somebody else's document — so the question is not "is this person done with it"
 * but "is anyone using it at all".
 */
CREATE OR REPLACE FUNCTION app.blob_is_unreferenced(p_checksum text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM app.document WHERE checksum = p_checksum)
     AND NOT EXISTS (SELECT 1 FROM app.storage_object WHERE checksum = p_checksum)
     AND NOT EXISTS (SELECT 1 FROM app.blob_upload WHERE checksum = p_checksum);
$$;

COMMENT ON FUNCTION app.blob_is_unreferenced IS
  'True when no document, ledger row or upload in flight references these bytes.';

-- ---------------------------------------------------------------------------
-- Search stops at the trash
-- ---------------------------------------------------------------------------

/*
 * The 0012 function with one condition added: a deleted document's chunks are not results.
 *
 * Repeated in full rather than patched, because `CREATE OR REPLACE FUNCTION` replaces the
 * body wholesale and a partial copy here would silently drop the trigram half. The room
 * scope is still resolved inside the query in both halves — that property is the reason
 * this function exists, and it survives being rewritten.
 */
CREATE OR REPLACE FUNCTION app.search_chunks(
  p_person_id uuid,
  p_query     text,
  p_room_ids  uuid[] DEFAULT NULL,
  p_limit     integer DEFAULT 10
)
RETURNS TABLE (
  chunk_id    uuid,
  document_id uuid,
  room_id     uuid,
  ord         integer,
  heading     text,
  text        text,
  filename    text,
  rank        real,
  match       text
)
LANGUAGE sql
STABLE
AS $$
  WITH scope AS (
    SELECT a.room_id
    FROM app.accessible_room_ids(p_person_id) a
    WHERE p_room_ids IS NULL
       OR cardinality(p_room_ids) = 0
       OR a.room_id = ANY (p_room_ids)
  ),
  q AS (
    SELECT
      websearch_to_tsquery('swedish', p_query) AS tsq,
      nullif(btrim(lower(p_query)), '') AS needle,
      length(btrim(p_query)) >= 4       AS fuzzy_worthwhile
  ),
  live AS (
    SELECT d.id, d.filename
    FROM app.document d
    WHERE d.deleted_at IS NULL
  ),
  fts AS (
    SELECT
      c.id, c.document_id, c.room_id, c.ord, c.heading, c.text,
      ts_rank_cd(c.fts, q.tsq) AS rank,
      'fts'::text AS match
    FROM app.chunk c
    JOIN scope s ON s.room_id = c.room_id
    JOIN live l ON l.id = c.document_id
    CROSS JOIN q
    WHERE q.tsq IS NOT NULL
      AND c.fts @@ q.tsq
  ),
  fuzzy AS (
    SELECT
      c.id, c.document_id, c.room_id, c.ord, c.heading, c.text,
      (0.05 + 0.05 * similarity(lower(c.text), q.needle))::real AS rank,
      'compound'::text AS match
    FROM app.chunk c
    JOIN scope s ON s.room_id = c.room_id
    JOIN live l ON l.id = c.document_id
    CROSS JOIN q
    WHERE q.fuzzy_worthwhile
      AND q.needle IS NOT NULL
      AND position(q.needle IN lower(c.text)) > 0
      AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = c.id)
  ),
  merged AS (
    SELECT * FROM fts
    UNION ALL
    SELECT * FROM fuzzy
  )
  SELECT
    m.id,
    m.document_id,
    m.room_id,
    m.ord,
    m.heading,
    m.text,
    l.filename,
    m.rank,
    m.match
  FROM merged m
  JOIN live l ON l.id = m.document_id
  ORDER BY m.rank DESC, m.document_id, m.ord
  LIMIT greatest(p_limit, 0);
$$;

COMMENT ON FUNCTION app.search_chunks IS
  'Postgres FTS over document chunks plus a trigram fallback for Swedish compounds. '
  'Room scope resolved in the query, in both halves, never after. Skips the trash.';
