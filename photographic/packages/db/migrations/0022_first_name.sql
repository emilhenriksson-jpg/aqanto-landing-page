-- A person's first name is their own data, not a settings field: it lives in app.item
-- under a dedicated kind so it gets exactly the same provenance, history and 30-day
-- trash treatment as anything else a person owns, mirroring how 0015 stored the
-- Personal Compass as memory rather than as a second source of truth beside it.
--
-- app.person.display_name stays the read cache every existing surface already joins
-- against — provenance, invites, room membership, the history feed — kept in sync by
-- the same write that creates the item, the same way app.profile caches the compass
-- rather than being a second source of truth for it.
ALTER TYPE app.item_kind ADD VALUE 'name';
