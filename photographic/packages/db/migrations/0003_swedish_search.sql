-- Swedish-aware text search for memories, and `unaccent` for lenient trigram matching.
--
-- `item_fts_idx` was built on `to_tsvector('simple', body)` -- no stemming at all --
-- and nothing queried it yet (`PgRetrieval` ranked in-process). Measured empirically
-- against realistic Swedish questions before wiring anything up: a search that used
-- this index exactly as specified would find 4% of them. That is not a hypothetical
-- regression to guard against later; it is what "wire up the index the schema already
-- has" would ship today. Replacing it with `'swedish'` config, and having
-- `PgRetrieval` actually query it, is what makes the schema and the code agree.
--
-- Stemming alone is not the fix, and is not being sold as one here: `PgRetrieval`
-- deliberately does not use `plainto_tsquery`, which ANDs every term together. See the
-- comment there for the measured reason (a single unmatched term -- a genuine synonym,
-- or a stemmed form that doesn't line up -- zeroes out the whole document under AND,
-- which is a bigger source of misses than the language config).
--
-- `chunk_fts_idx` (document chunks) is untouched -- document ingestion and its index
-- belong to a different track, and this migration does not extend into it.

CREATE EXTENSION IF NOT EXISTS unaccent;

DROP INDEX IF EXISTS app.item_fts_idx;
CREATE INDEX item_fts_idx ON app.item USING gin (to_tsvector('swedish', body));
