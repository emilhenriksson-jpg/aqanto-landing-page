-- ---------------------------------------------------------------------------
-- Documents as first-class memory, and the storage counter behind the 10 GB limit.
--
-- Numbered from 0010 rather than 0003 on purpose. Two tracks add migrations to this
-- directory at the same time: the event log and calendar own the domain tables and
-- take 0003-0009, platform/storage/document migrations start here. Files are applied
-- in filename order, so a gap costs nothing and renumbering someone else's migration
-- after it has been applied costs a database.
--
-- Three things this adds, and why each is a column rather than a convention:
--
--   1. `document.text` — the text we extracted from the original file, kept apart from
--      `document.summary`, which a model wrote. The product promise is that the source
--      is always reachable, and one `text` column that sometimes holds our extraction
--      and sometimes holds an AI's paraphrase is how that promise quietly stops being
--      true. Original and understanding do not share storage here.
--
--   2. Extraction state. A document whose bytes are safe but whose text could not be
--      read is a normal outcome, not an error: a scanned PDF has no text layer and
--      losing the file over that is never acceptable. So extraction has its own status,
--      its own Swedish explanation, and the upload succeeds either way.
--
--   3. A storage ledger. 10 GB is a product limit, not a reserved quota, which means it
--      has to be counted rather than allocated — and counted atomically, or two
--      concurrent uploads both pass a check that neither should have passed.
--
-- What this deliberately does NOT add: row-level security policies for documents or
-- chunks. Authorization lives in the API layer, in one place, and duplicating room
-- permissions into the database is what would make "the platform can be swapped later"
-- a thing we say rather than a thing that is true. The inert SELECT policies from
-- 0001 stay as they are; nothing new joins them.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Original text and extraction state
-- ---------------------------------------------------------------------------

CREATE TYPE app.extraction_status AS ENUM (
  'pending',      -- stored, not yet processed
  'extracted',    -- text available
  'unsupported',  -- no extractor for this type; file still downloadable
  'empty',        -- read fine, contained no text (a scan without an OCR layer)
  'failed'        -- corrupt, encrypted, or over a limit
);

ALTER TABLE app.document
  -- Our extraction, verbatim. Never overwritten by anything a model produced.
  ADD COLUMN text              text,
  ADD COLUMN extraction_status app.extraction_status NOT NULL DEFAULT 'pending',
  -- Swedish, shown to the person who uploaded the file. Truncation and skipped pages
  -- are their business, not ours to hide.
  ADD COLUMN extraction_error  text,
  ADD COLUMN extraction_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Which extractor ran, so a document processed by an older version can be found and
  -- redone without guessing from the filename.
  ADD COLUMN extractor         text,
  ADD COLUMN page_count        integer,
  ADD COLUMN chunk_count       integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN app.document.text IS
  'Text extracted from the original file. Original, not AI-generated: see summary.';
COMMENT ON COLUMN app.document.summary IS
  'AI-generated understanding of the document. Never the source of truth.';

-- `extracted_at` from 0001 and the status have to agree, or "is this searchable yet"
-- has two answers and the UI picks the wrong one.
ALTER TABLE app.document
  ADD CONSTRAINT document_extraction_consistent CHECK (
    (extraction_status = 'pending' AND extracted_at IS NULL)
    OR (extraction_status <> 'pending' AND extracted_at IS NOT NULL)
  );

-- The extraction backlog, and the re-extraction sweep when an extractor improves.
CREATE INDEX document_extraction_pending_idx ON app.document (created_at)
  WHERE extraction_status = 'pending';

-- Same bytes, same person, uploaded to two rooms: one object, two documents. The
-- storage ledger charges for the object, this finds the documents pointing at it.
CREATE INDEX document_checksum_idx ON app.document (checksum);

CREATE INDEX document_uploaded_by_idx ON app.document (uploaded_by);

-- ---------------------------------------------------------------------------
-- Chunks: full-text search now, embeddings later without reprocessing
-- ---------------------------------------------------------------------------

-- The heading a chunk sits under, when the source had one. A citation that cannot say
-- which section it came from is a quote without a page number.
ALTER TABLE app.chunk
  ADD COLUMN heading text;

/*
 * The search vector, stored and generated.
 *
 * Generated rather than maintained by a trigger or the application: a chunk whose text
 * and whose index disagree is a document that is silently unsearchable, and there is no
 * failure mode where that is noticed. Postgres recomputing it is free by comparison.
 *
 * 'swedish' rather than the 'simple' config `app.item` uses. Items are short curated
 * sentences a person wrote and will search for in roughly the words they wrote; a
 * document is long prose nobody wrote for retrieval, where "dokumenten" not matching
 * "dokument" is the difference between finding a contract and not. Item ranking is
 * unchanged by this migration.
 *
 * Only FTS runs over these chunks today. `embedding` has been on this table since 0001
 * and stays null for now — the point of chunking at ingest is that turning embeddings
 * on later is a backfill of one column, not a re-extraction of every document.
 */
ALTER TABLE app.chunk
  ADD COLUMN fts tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('swedish', coalesce(heading, '')), 'B') ||
    setweight(to_tsvector('swedish', coalesce(text, '')), 'D')
  ) STORED;

CREATE INDEX chunk_fts_swedish_idx ON app.chunk USING gin (fts);

-- The document's chunks in order, for re-extraction and for reading a document back.
CREATE INDEX chunk_document_ord_idx ON app.chunk (document_id, ord);

-- ---------------------------------------------------------------------------
-- Storage ledger
-- ---------------------------------------------------------------------------

/*
 * One row per person per distinct object they store.
 *
 * Keyed on the checksum because the blob store is content-addressed: the same PDF in
 * two rooms is one object on disk, and charging a person twice for one object would be
 * a bill for storage nobody is using. Keyed per person rather than globally because
 * deduplication across people must never be observable — whether someone else already
 * uploaded your file is not something your quota should reveal.
 */
CREATE TABLE app.storage_object (
  person_id     uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  checksum      text NOT NULL,
  byte_size     bigint NOT NULL CHECK (byte_size >= 0),
  storage_key   text NOT NULL,
  ref_count     integer NOT NULL DEFAULT 1 CHECK (ref_count >= 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, checksum)
);

/*
 * The counter itself, maintained alongside the ledger.
 *
 * Denormalised from `storage_object` on purpose. This number is read on the upload path,
 * where it gates a write, and `sum(byte_size)` over a person's objects is a scan that
 * grows with exactly the thing the limit exists to bound.
 */
CREATE TABLE app.storage_usage (
  person_id    uuid PRIMARY KEY REFERENCES app.person (id) ON DELETE CASCADE,
  bytes_used   bigint NOT NULL DEFAULT 0 CHECK (bytes_used >= 0),
  object_count integer NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.storage_usage IS
  'Product limit, not a reserved quota: a person using 80 MB costs 80 MB.';

/*
 * Reserves room for an object, or refuses.
 *
 * One statement, so the check and the increment cannot be separated. Two uploads racing
 * to the last megabyte is not a hypothetical — it is what a phone retrying a failed
 * 40 MB upload does — and a SELECT followed by an UPDATE lets both through.
 *
 * `allowed = false` changes nothing. The caller has already written the bytes to the
 * blob store by then (the checksum is not knowable before reading them) and is expected
 * to leave them; an object nobody references is cheap and the retry is free, while
 * refusing before the bytes exist would mean trusting a client-declared length.
 *
 * Re-uploading the same bytes bumps `ref_count` and is always allowed, even over the
 * limit: it consumes nothing new, and failing it would break the one path that most
 * needs to be idempotent.
 */
CREATE OR REPLACE FUNCTION app.reserve_storage(
  p_person_id   uuid,
  p_checksum    text,
  p_byte_size   bigint,
  p_storage_key text,
  p_limit_bytes bigint
)
RETURNS TABLE (
  allowed       boolean,
  deduplicated  boolean,
  bytes_used    bigint,
  limit_bytes   bigint
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing app.storage_object;
  v_used     bigint;
BEGIN
  -- Lock the counter row first, creating it if this is the person's first upload.
  -- Everything after this point is serialised per person, which is the granularity the
  -- limit is defined at.
  INSERT INTO app.storage_usage (person_id)
  VALUES (p_person_id)
  ON CONFLICT (person_id) DO NOTHING;

  SELECT u.bytes_used INTO v_used
  FROM app.storage_usage u
  WHERE u.person_id = p_person_id
  FOR UPDATE;

  SELECT * INTO v_existing
  FROM app.storage_object o
  WHERE o.person_id = p_person_id AND o.checksum = p_checksum;

  IF FOUND THEN
    UPDATE app.storage_object o
    SET ref_count = o.ref_count + 1
    WHERE o.person_id = p_person_id AND o.checksum = p_checksum;

    RETURN QUERY SELECT true, true, v_used, p_limit_bytes;
    RETURN;
  END IF;

  IF v_used + p_byte_size > p_limit_bytes THEN
    RETURN QUERY SELECT false, false, v_used, p_limit_bytes;
    RETURN;
  END IF;

  INSERT INTO app.storage_object (person_id, checksum, byte_size, storage_key)
  VALUES (p_person_id, p_checksum, p_byte_size, p_storage_key);

  UPDATE app.storage_usage u
  SET bytes_used   = u.bytes_used + p_byte_size,
      object_count = u.object_count + 1,
      updated_at   = now()
  WHERE u.person_id = p_person_id;

  RETURN QUERY SELECT true, false, v_used + p_byte_size, p_limit_bytes;
END;
$$;

COMMENT ON FUNCTION app.reserve_storage IS
  'Atomic check-and-increment for the storage limit. Called on the upload path.';

/*
 * Gives the space back when the last document referencing an object is gone.
 *
 * Returns true when the object itself became unreferenced, which is the signal the
 * caller needs to delete the blob. Deleting it while another document still points at
 * the same checksum would break that document instead.
 */
CREATE OR REPLACE FUNCTION app.release_storage(
  p_person_id uuid,
  p_checksum  text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_size      bigint;
  v_remaining integer;
BEGIN
  SELECT byte_size INTO v_size
  FROM app.storage_object
  WHERE person_id = p_person_id AND checksum = p_checksum
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE app.storage_object
  SET ref_count = greatest(ref_count - 1, 0)
  WHERE person_id = p_person_id AND checksum = p_checksum
  RETURNING ref_count INTO v_remaining;

  IF v_remaining > 0 THEN
    RETURN false;
  END IF;

  DELETE FROM app.storage_object
  WHERE person_id = p_person_id AND checksum = p_checksum;

  UPDATE app.storage_usage
  SET bytes_used   = greatest(bytes_used - v_size, 0),
      object_count = greatest(object_count - 1, 0),
      updated_at   = now()
  WHERE person_id = p_person_id;

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Full-text search over chunks
-- ---------------------------------------------------------------------------

/*
 * Ranked chunk search, scoped to the rooms a person can reach.
 *
 * The scope is resolved inside the query through `app.accessible_room_ids`, not applied
 * to the results afterwards. This is the same rule the ports state and the same reason:
 * a post-filter is one forgotten line away from returning another person's room, and
 * that failure looks like a working search.
 *
 * A function rather than a view so the room scope is an argument the caller cannot
 * forget to pass.
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
  rank        real
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
    SELECT websearch_to_tsquery('swedish', p_query) AS tsq
  )
  SELECT
    c.id,
    c.document_id,
    c.room_id,
    c.ord,
    c.heading,
    c.text,
    d.filename,
    ts_rank_cd(c.fts, q.tsq) AS rank
  FROM app.chunk c
  JOIN scope s ON s.room_id = c.room_id
  JOIN app.document d ON d.id = c.document_id
  CROSS JOIN q
  WHERE q.tsq IS NOT NULL
    AND c.fts @@ q.tsq
  ORDER BY rank DESC, c.document_id, c.ord
  LIMIT greatest(p_limit, 0);
$$;

COMMENT ON FUNCTION app.search_chunks IS
  'Postgres FTS over document chunks. Room scope resolved in the query, never after.';
