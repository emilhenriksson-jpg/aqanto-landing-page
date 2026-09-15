-- The least-privilege application role, created and granted in one place.
--
-- Supersedes `0016_app_role_grants.sql`, which is still in the ledger and must stay
-- there. `0016` was wrapped in `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname =
-- 'photographic_app')`, so on a database where the role had not been created yet it did
-- nothing at all -- and then the ledger recorded it as applied, so it could never run
-- again. Production is in exactly that state: `0016` applied, no role, and zero grants
-- across 28 tables, 3 sequences and 17 functions. Creating the role afterwards produced
-- an application that could reach nothing, silently, until the first query.
--
-- Two Postgres facts shape what follows, and getting either wrong reproduces the bug:
--
--  1. **A role is cluster-wide; its privileges are per database.** So "the role exists"
--     and "the role can reach anything in *this* database" are different questions. On a
--     cluster already running another Photografic database the role is present here with
--     no privileges whatsoever, which is indistinguishable from the broken state above.
--     That is why creation is conditional and granting is not.
--  2. `ALTER DEFAULT PRIVILEGES` only covers objects created *later*, by the role it is
--     recorded against. It is necessary and it is not sufficient: the explicit `ON ALL`
--     grants below are what cover everything that already exists.
--
-- Written to be re-runnable and correct from any starting point -- fresh database,
-- restored backup, or a cluster where the role is already present -- so that no operator
-- has to remember an out-of-band step for it to be true.

-- Creation only. No password and no privileges are implied by this: a role that cannot
-- authenticate is exactly right here, because the credential is the operator's to set
-- (`ALTER ROLE photographic_app PASSWORD '...'`, see scripts/deploy.md) and a password in
-- a migration is a password in the repository.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'photographic_app') THEN
    CREATE ROLE photographic_app LOGIN;
  END IF;
END
$$;

-- Everything below runs unconditionally. Guarding these on the role being newly created
-- is the same mistake as guarding them on it pre-existing: in both cases a database ends
-- up with the role and without the grants, and nothing says so.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO photographic_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA app TO photographic_app;

-- DML and no DDL. The application cannot reach `DROP TABLE app.event` or
-- `ALTER TABLE ... DISABLE TRIGGER`, which is what "the log is the truth" rests on: the
-- append-only rules are enforced by row triggers, and a role that can disable them can
-- rewrite history without leaving a trace of having done so.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO photographic_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO photographic_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO photographic_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO photographic_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO photographic_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO photographic_app;

-- Two refusals that matter as much as the grants.
--
-- The ledger is readable and not writable: a row inserted into `app.schema_migrations` is
-- a migration that will never run, which is the silent-wrong-schema outcome the old
-- adoption heuristic used to cause and that the content-keyed ledger now refuses to guess
-- its way into. The application has no business writing there at all.
REVOKE INSERT, UPDATE, DELETE ON app.schema_migrations FROM photographic_app;

-- `TRUNCATE` bypasses row triggers, so it would empty a table the append-only rules are
-- meant to protect without firing any of them. Never granted above, revoked here anyway,
-- because this is the statement someone should find when they go looking for whether it
-- is possible.
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA app FROM photographic_app;
