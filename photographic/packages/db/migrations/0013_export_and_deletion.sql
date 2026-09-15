-- ---------------------------------------------------------------------------
-- Export, and permanent deletion of an account.
--
-- Both are built early on purpose. They are the two features that get deferred
-- indefinitely and then cannot be retrofitted: an export is only portable if the event
-- log was kept in a shape that can be streamed out, and a deletion is only honest if
-- the schema was built expecting one. Waiting until someone asks means discovering that
-- `app.event` is append-only, references `app.person` without cascade, and that
-- deleting a person would either fail or take other people's history with it.
--
-- Which is exactly what this migration has to work around, so it is worth stating: the
-- person row cannot be hard-deleted. That is a consequence of the schema, not a
-- preference. `event.actor_person_id` and `room.created_by` point at `app.person` with
-- no cascade, and the log refuses DELETE by trigger. A cascade would either error or
-- erase the history of everyone who shared a room with them. So the row becomes a
-- tombstone: contact details gone, handle rotated, display name replaced, and every
-- reference to it still resolving.
--
-- Say plainly what that is: pseudonymisation, not anonymisation. Someone who remembers
-- who wrote a note in a shared room can still re-identify it. Claiming otherwise would
-- be a promise the data model cannot keep.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Export
-- ---------------------------------------------------------------------------

CREATE TYPE app.export_status AS ENUM ('pending', 'running', 'ready', 'failed', 'expired');

/*
 * What an export covers, and why this is two values rather than one.
 *
 * `own` is the person's own memory: their personal room in full, everything they
 * authored anywhere, and every event they are the actor of. This is what the product
 * promise needs — change AI without starting over — and it is unambiguously theirs.
 *
 * `rooms` additionally takes full transcripts of named shared rooms, including other
 * members' writing. That is a materially different act and is therefore a separate,
 * explicit request rather than the default. See `EXPORT.md`; the short version is that
 * reading a room in the app is gated on current membership and revocable, while a zip
 * on a laptop is neither, so "they can read it anyway" is not the same as "they may
 * keep a permanent copy".
 */
CREATE TYPE app.export_scope AS ENUM ('own', 'rooms');

CREATE TABLE app.export_job (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id      uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  scope          app.export_scope NOT NULL DEFAULT 'own',
  -- Rooms whose full transcript was requested. Always a subset of what the person could
  -- reach at request time, re-checked when the job runs: a room they left in between
  -- must not appear in the archive.
  requested_rooms uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  status         app.export_status NOT NULL DEFAULT 'pending',

  -- Where the finished archive lives, through the storage port like any other object.
  storage_key    text,
  byte_size      bigint,
  checksum       text,

  -- Counts for the manifest, and for telling a person what they are about to download.
  event_count    integer,
  item_count     integer,
  document_count integer,

  -- The highest event seq included. An export is a snapshot, and saying which one makes
  -- two exports comparable instead of merely different.
  through_seq    bigint,

  error          text,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  -- Seven days. Long enough to notice the email, short enough that an archive of
  -- someone's whole memory is not sitting in object storage indefinitely.
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '7 days'
);

CREATE INDEX export_job_person_idx ON app.export_job (person_id, requested_at DESC);
CREATE INDEX export_job_pending_idx ON app.export_job (requested_at)
  WHERE status IN ('pending', 'running');
CREATE INDEX export_job_expiry_idx ON app.export_job (expires_at)
  WHERE status = 'ready';

COMMENT ON TABLE app.export_job IS
  'One export request. The archive itself lives behind the storage port.';

/*
 * Download tokens, hashed.
 *
 * A signed link rather than an authenticated download, because the archive is delivered
 * by email and the person opening it may not have a session in that browser. Hashed for
 * the same reason `oauth_token` is: a dump of this table must not be a set of working
 * links to people's entire memory.
 *
 * Single-use is deliberately *not* enforced. A download that fails halfway on a phone
 * is the normal case for a multi-gigabyte archive, and a one-shot link turns that into
 * "request it again and wait". The expiry is the control.
 */
CREATE TABLE app.export_download (
  token_hash   text PRIMARY KEY,
  export_id    uuid NOT NULL REFERENCES app.export_job (id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  use_count    integer NOT NULL DEFAULT 0
);

CREATE INDEX export_download_job_idx ON app.export_download (export_id);

-- ---------------------------------------------------------------------------
-- Account deletion
-- ---------------------------------------------------------------------------

CREATE TYPE app.deletion_status AS ENUM ('requested', 'cancelled', 'completed');

/*
 * What the person chose about their contributions in shared rooms.
 *
 * No default, and the column is NOT NULL, so a deletion cannot be recorded without the
 * decision having been made. The consent text says this choice is never preselected;
 * making the column mandatory is what turns that from a UI convention into a property
 * of the system — a future admin screen or script cannot skip it.
 *
 * `keep` is what the invite consent promised would happen ("det du skriver i ett delat
 * rum ... stannar där även om du senare lämnar det"). `remove` is the person overriding
 * that in their own favour, which they are always allowed to do.
 */
CREATE TYPE app.contribution_choice AS ENUM ('keep', 'remove');

CREATE TABLE app.account_deletion (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  status        app.deletion_status NOT NULL DEFAULT 'requested',

  -- `true` for "radera nu": no freeze, and the harder warning was shown.
  immediate     boolean NOT NULL DEFAULT false,
  contributions app.contribution_choice NOT NULL,

  requested_at  timestamptz NOT NULL DEFAULT now(),
  -- When the sweep may execute it. `now()` for the immediate path, +30 days otherwise.
  execute_after timestamptz NOT NULL,
  cancelled_at  timestamptz,
  completed_at  timestamptz,

  -- What was actually removed, kept after the fact. The person row is a tombstone by
  -- then, so this is the only place that can answer "was this account deleted, and what
  -- happened to it" — and an erasure nobody can evidence is not much of an erasure.
  removed       jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- At most one open request per person. A second "delete my account" while one is already
-- pending is the same request, not a second one — and two rows would mean two sweeps.
CREATE UNIQUE INDEX account_deletion_open_idx ON app.account_deletion (person_id)
  WHERE status = 'requested';

CREATE INDEX account_deletion_due_idx ON app.account_deletion (execute_after)
  WHERE status = 'requested';

COMMENT ON TABLE app.account_deletion IS
  'A deletion request and its outcome. Survives the person row, which becomes a tombstone.';

-- ---------------------------------------------------------------------------
-- The tombstone
-- ---------------------------------------------------------------------------

/*
 * Turns a person into a tombstone, and reports what it removed.
 *
 * Everything unambiguously the person's own goes: contact details, handle, display name,
 * credentials, OAuth clients and tokens, sessions, access logs. What stays is the row
 * itself and its id, because the append-only log and `room.created_by` both point at it.
 *
 * Returns the counts rather than nothing, so `account_deletion.removed` can record what
 * happened. An erasure with no evidence it ran is not auditable, and this is the one
 * operation nobody can repeat to check.
 *
 * The personal room and its contents are *not* deleted here. That is deliberate: they
 * are deleted by the caller through the storage port first, because the files have to go
 * before the rows that name them — a row deleted first is a blob nobody can find again.
 */
CREATE OR REPLACE FUNCTION app.tombstone_person(p_person_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_credentials integer;
  v_tokens      integer;
  v_clients     integer;
  v_sessions    integer;
  v_access      integer;
  v_memberships integer;
BEGIN
  DELETE FROM app.credential WHERE person_id = p_person_id;
  GET DIAGNOSTICS v_credentials = ROW_COUNT;

  DELETE FROM app.oauth_token WHERE person_id = p_person_id;
  GET DIAGNOSTICS v_tokens = ROW_COUNT;

  -- Registrations this person's clients made. `oauth_client` has no person column, so
  -- they are reached through the grants, which do.
  DELETE FROM app.oauth_client c
  WHERE EXISTS (
    SELECT 1 FROM app.client_grant g
    WHERE g.client_id = c.client_id AND g.person_id = p_person_id
  )
  AND NOT EXISTS (
    -- Unless another person also authorized the same registration, which happens for a
    -- hosted client. Deleting it would disconnect them.
    SELECT 1 FROM app.client_grant g2
    WHERE g2.client_id = c.client_id AND g2.person_id <> p_person_id
  );
  GET DIAGNOSTICS v_clients = ROW_COUNT;

  DELETE FROM app.client_session WHERE person_id = p_person_id;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  DELETE FROM app.access_log WHERE person_id = p_person_id;
  GET DIAGNOSTICS v_access = ROW_COUNT;

  -- Shared-room memberships end. The row staying would mean a deleted account still
  -- counted as a member, and `accessible_room_ids` would still resolve for it.
  UPDATE app.membership SET left_at = coalesce(left_at, now())
  WHERE person_id = p_person_id AND left_at IS NULL;
  GET DIAGNOSTICS v_memberships = ROW_COUNT;

  -- The tombstone itself. `handle` is rotated rather than nulled because it is UNIQUE
  -- and a second deleted account would collide on NULL in some future index.
  UPDATE app.person
  SET display_name = 'Borttagen användare',
      email        = NULL,
      phone        = NULL,
      handle       = 'borttagen-' || replace(gen_random_uuid()::text, '-', ''),
      deleted_at   = coalesce(deleted_at, now())
  WHERE id = p_person_id;

  RETURN jsonb_build_object(
    'credentials', v_credentials,
    'oauth_tokens', v_tokens,
    'oauth_clients', v_clients,
    'sessions', v_sessions,
    'access_log_rows', v_access,
    'memberships_ended', v_memberships
  );
END;
$$;

COMMENT ON FUNCTION app.tombstone_person IS
  'Pseudonymises a person. Not anonymisation: the id survives because the log needs it.';

/*
 * Revokes every live token a person holds, right now.
 *
 * Called the moment a deletion is *requested*, on both paths, before anything is
 * removed. The account stops being reachable by any connected AI in the same second,
 * which is what makes a thirty-day freeze cost nothing in privacy — during it the data
 * is unreachable, and the window buys only the chance to change one's mind.
 *
 * First-party browser sessions are deliberately untouched: the person has to be able to
 * log in during the freeze to cancel, and to export. That distinction already exists in
 * the API layer, which is where it belongs.
 */
CREATE OR REPLACE FUNCTION app.revoke_all_tokens(p_person_id uuid)
RETURNS integer
LANGUAGE sql
AS $$
  WITH revoked AS (
    UPDATE app.oauth_token
    SET revoked_at = now()
    WHERE person_id = p_person_id AND revoked_at IS NULL
    RETURNING 1
  )
  SELECT count(*)::integer FROM revoked;
$$;
