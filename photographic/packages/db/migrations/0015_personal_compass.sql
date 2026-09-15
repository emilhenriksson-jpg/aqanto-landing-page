-- The Personal Compass is a memory like any other, not a parallel settings store: it
-- lives in app.item under a dedicated kind so provenance, history and trash apply to it
-- unchanged. `structured->>'compassKey'` says which of the six fixed principles a row
-- fills; the set of six keys itself lives in code
-- (packages/core/src/compass.ts), not in this schema, so a principle nobody has
-- customised yet has no row here and does not fabricate a decision the person never
-- made.
ALTER TYPE app.item_kind ADD VALUE 'compass';

-- Proposals need to carry the same tag through to approval, or an approved Compass
-- change would land as an ordinary instruction with no principle to attach to. Mirrors
-- app.item.structured exactly, including the empty-object default for every proposal
-- that isn't a Compass change.
ALTER TABLE app.proposal ADD COLUMN structured jsonb NOT NULL DEFAULT '{}'::jsonb;

-- app.profile already caches the rendered `sections` alongside the items they were
-- built from, so a session read never has to re-scan app.item. `compass` is the same
-- cache, holding the same six-entry structure `compassEntriesFrom` computes in
-- packages/core/src/compass.ts, not a second source of truth for it.
ALTER TABLE app.profile ADD COLUMN compass jsonb NOT NULL DEFAULT '[]'::jsonb;
