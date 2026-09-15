-- ---------------------------------------------------------------------------
-- Swedish compounds in document search.
--
-- 0010 gave `app.chunk` a Swedish tsvector, which handles inflection: a search for
-- "dokument" finds "Dokumenten". What it does not handle is compounding, and Swedish
-- compounds constantly.
--
--   to_tsvector('swedish', 'uppsägningstiden är tre månader')  ->  'uppsägningstid'
--   websearch_to_tsquery('swedish', 'uppsägning')              ->  'uppsägning'
--
-- No match. The Snowball stemmer trims inflection off the end of a word and never
-- splits one, so "uppsägning" does not find "uppsägningstiden", "hyra" does not find
-- "hyresavtalet", and "styrelse" does not find "styrelsemötet". The same conservatism
-- leaves some definite forms alone entirely — "förvärvet" does not stem to "förvärv" —
-- so even a non-compound search can miss.
--
-- For short curated memories this barely matters: a person searches roughly in the
-- words they wrote. For documents it matters a lot, because nobody wrote a contract
-- with retrieval in mind, and "I searched for uppsägning and it did not find the
-- contract that is entirely about uppsägningstid" is the product failing at the one
-- thing this feature is for.
--
-- The fix is a second, weaker signal rather than a different primary one. Full-text
-- ranking stays in charge; trigram similarity catches what stemming cannot reach, and
-- is scored below every full-text hit so it can only ever add results at the bottom.
-- `pg_trgm` is already installed (0001) and `app.item` already uses it the same way.
--
-- Not a dictionary. A Swedish compound-splitting dictionary is the better answer
-- eventually and is a much larger commitment: `ispell`/`hunspell` affix files have to be
-- installed on every database host, which is a deployment dependency that would make
-- the "swap the platform later" promise harder to keep. Trigrams need nothing.
-- ---------------------------------------------------------------------------

-- Substring and similarity matching over chunk text. Partial on nothing: every chunk is
-- a candidate, and the index is what keeps a `%uppsägning%` scan off the table.
CREATE INDEX chunk_text_trgm_idx ON app.chunk USING gin (text gin_trgm_ops);

-- `CREATE OR REPLACE` cannot widen a `RETURNS TABLE`, and this adds a `match` column so
-- a caller (and a reviewer) can see which half of the query produced a row. Dropped by
-- full signature so this is unambiguous about which overload goes.
DROP FUNCTION IF EXISTS app.search_chunks(uuid, text, uuid[], integer);

/*
 * Ranked chunk search: full-text first, trigram second.
 *
 * Replaces the 0010 version. The room scope is still resolved inside the query through
 * `app.accessible_room_ids` and never applied to the results afterwards — a post-filter
 * is one forgotten line away from returning another person's room, and that failure
 * looks like a working search.
 *
 * Both halves are scoped, not just the first. That is the part worth checking in review:
 * a second source of candidates is a second place the room filter can be missing.
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
      -- Trigram matching is only meaningful for a term long enough to have trigrams.
      -- Below four characters it matches most of the language, so it is switched off
      -- rather than left to flood the tail of every result set.
      nullif(btrim(lower(p_query)), '') AS needle,
      length(btrim(p_query)) >= 4       AS fuzzy_worthwhile
  ),
  fts AS (
    SELECT
      c.id, c.document_id, c.room_id, c.ord, c.heading, c.text,
      ts_rank_cd(c.fts, q.tsq) AS rank,
      'fts'::text AS match
    FROM app.chunk c
    JOIN scope s ON s.room_id = c.room_id
    CROSS JOIN q
    WHERE q.tsq IS NOT NULL
      AND c.fts @@ q.tsq
  ),
  /*
   * Compound and partial matches, as a substring of the chunk.
   *
   * `position` rather than `similarity`: the case this exists for is a query that is a
   * *part* of a longer word, and whole-string similarity between "uppsägning" and a
   * 1200-character chunk is near zero no matter how well it matches. A containment test
   * is what actually answers the question, and the trigram index serves it.
   */
  fuzzy AS (
    SELECT
      c.id, c.document_id, c.room_id, c.ord, c.heading, c.text,
      -- Scored into a band strictly below full-text hits, so this can only append to
      -- the tail of a result set and never reorder what stemming already found.
      (0.05 + 0.05 * similarity(lower(c.text), q.needle))::real AS rank,
      'compound'::text AS match
    FROM app.chunk c
    JOIN scope s ON s.room_id = c.room_id
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
    d.filename,
    m.rank,
    m.match
  FROM merged m
  JOIN app.document d ON d.id = m.document_id
  ORDER BY m.rank DESC, m.document_id, m.ord
  LIMIT greatest(p_limit, 0);
$$;

COMMENT ON FUNCTION app.search_chunks IS
  'Postgres FTS over document chunks plus a trigram fallback for Swedish compounds. '
  'Room scope resolved in the query, in both halves, never after.';
