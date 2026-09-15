-- Which model saw this memory's text, and when.
--
-- Scope §4 asks every memory to answer where the information came from and how we know
-- it. Once embeddings are computed by an external provider, "your text was sent to a
-- model at write time" is part of that answer, and it was not recorded anywhere:
-- `MemorySource` carries kind/label/ref/uri and describes where the information came
-- from *before* Photographic saw it, which is a different question and the wrong place
-- to overload.
--
-- Three columns on the item rather than an event per embedding. An `item.embedded` event
-- would double the log's volume for something that is not a memory event — it would have
-- to be excluded from the calendar, the history feed, `recent` and `ask` one allowlist at
-- a time — and the question this answers is about the current row: which model holds a
-- vector derived from this text right now.
--
-- `embedding_model` doubles as the backfill's work list. An item is unembedded when
-- `embedding IS NULL`, and *stale* when its model is not the one now configured — which
-- is the same query, and is why switching from the deterministic fake to a real provider
-- does not need a separate migration to redo the vectors it already wrote.
--
-- Deliberately not on `app.chunk`: `chunk.embedding` is still never written
-- (documents.ts), so no document text has been sent to a model. When that backfill runs
-- it should add the same three columns here rather than invent its own shape.

ALTER TABLE app.item
  ADD COLUMN embedding_model    text,
  ADD COLUMN embedding_provider text,
  ADD COLUMN embedded_at        timestamptz;

COMMENT ON COLUMN app.item.embedding_provider IS
  'Who computed app.item.embedding: ''openai'' means this body left our servers. NULL means no vector was ever computed for it.';

-- The backfill''s own index: find what still needs embedding, or was embedded by a model
-- we no longer use, without scanning every active memory.
CREATE INDEX item_embedding_backfill_idx
  ON app.item (embedding_model)
  WHERE status = 'active';
