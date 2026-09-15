-- A least-privilege role for the application, and nothing for it to drop.
--
-- The app has connected as the schema owner since the first deploy, which means any
-- injection or mistake in application code reaches `DROP TABLE app.event` — for this
-- product, the whole of everyone's memory rather than a bounded slice. The append-only
-- guarantee is enforced by triggers the owner can simply disable, so "the log is the
-- truth" has been resting on the application not making a mistake rather than on the
-- database refusing one.
--
-- Two roles, opposite needs. Migrations need DDL across the schema; the application needs
-- DML and the functions it calls, and no DDL whatsoever.
--
-- This migration only grants. It deliberately does **not** `CREATE ROLE`, because a login
-- role needs a password and a password does not belong in a file in the repository. The
-- operator creates the role once, out of band, with a generated password:
--
--   CREATE ROLE photographic_app LOGIN PASSWORD '<generated>';
--
-- and then points `DATABASE_URL` at it while `MIGRATION_DATABASE_URL` keeps the owner.
-- `scripts/deploy.md` has the full sequence including the rollback.
--
-- Guarded on the role existing so this is a no-op on a database where it does not —
-- local development, CI and every deploy before the operator has done that step. That is
-- what makes this safe to land ahead of the switch rather than as part of it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'photographic_app') THEN
    RAISE NOTICE 'photographic_app finns inte: hoppar över grants (se scripts/deploy.md)';
    RETURN;
  END IF;

  -- Reach the schema and its objects, but never create in it.
  EXECUTE 'GRANT USAGE ON SCHEMA app TO photographic_app';
  EXECUTE 'REVOKE CREATE ON SCHEMA app FROM photographic_app';

  -- The ordinary four. No TRUNCATE: it bypasses the row triggers that hold the
  -- append-only rules, and nothing in the application needs it.
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO photographic_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO photographic_app';

  -- `app.purge_expired_items`, `app.search_chunks`, `app.accessible_room_ids` and the
  -- rest are how the application does the things the schema deliberately does not let it
  -- do directly.
  EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO photographic_app';

  -- So a table added by a later migration is covered without anyone remembering to come
  -- back here. Applies to objects the migration role creates, which is the only role that
  -- creates any.
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO photographic_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO photographic_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO photographic_app';

  -- The ledger is the migration role's business. The application reads it for `/health`
  -- and must not be able to write it: a row inserted here is a migration that will never
  -- run, which is the same silent-wrong-schema outcome the adoption heuristic caused.
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON app.schema_migrations FROM photographic_app';
END
$$;
