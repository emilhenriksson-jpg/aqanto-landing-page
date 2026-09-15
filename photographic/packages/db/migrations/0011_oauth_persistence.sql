-- ---------------------------------------------------------------------------
-- OAuth state in Postgres, and a client identity that cannot rename itself.
--
-- `app.oauth_client`, `app.oauth_token` and `app.oauth_authorization` have existed
-- since 0001 and nothing has ever written to them: `wiring.ts` wires the in-memory
-- stores instead. Everything that follows from that is worse than it looks. Tokens and
-- registrations vanish on restart, so every revocation is temporary until the next
-- deploy. `Klienter` reads `app.client_session` rather than actual registrations, so
-- "which AIs can reach my memory" is answered from who happened to connect. And
-- `agent_client` is guessed by string-matching the name a client chose for itself,
-- which means a client picks its own label in the person's memory history.
--
-- This migration makes the tables real and adds the three things missing from them.
--
--   1. A parking table for in-flight authorization requests. Photographic has no
--      passwords, so `/oauth/authorize` validates the request, parks it, and sends the
--      browser to a login page that approves it later. Fixing the redirect URI and the
--      PKCE challenge *before* anyone sees a login screen is the security property, and
--      0001 gave it nowhere to live.
--
--   2. An immutable client identity. `client_label` and `agent_client` are derived once,
--      at registration, and then frozen by trigger. Provenance is the one thing that
--      cannot be backfilled, so a client must not be able to present one name today and
--      another tomorrow and have the person's own history follow it.
--
--   3. One row per person per client, which is what `Klienter` actually lists. It is
--      what a person renames ("Claude på jobbdatorn"), it is what per-client revocation
--      acts on, and it carries the daily write counter — because a client that suddenly
--      writes a thousand memories is either broken or taken over.
--
-- Not here, deliberately: `app.event.client_id`. Provenance on the event log belongs to
-- the track that owns the log, and this migration gives it the foreign key target to
-- point at rather than reaching into its table.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Client identity
-- ---------------------------------------------------------------------------

ALTER TABLE app.oauth_client
  -- What the person sees, in Swedish, when nothing renamed it. Derived from the
  -- registration name once and never again.
  ADD COLUMN client_label text NOT NULL DEFAULT 'okänd klient',
  -- The `AgentClient` value used for provenance. `unknown` is a real answer here, not a
  -- fallback to be improved on: a confidently wrong attribution next to "sparade" in
  -- someone's history is worse than an honest blank.
  ADD COLUMN agent_client text NOT NULL DEFAULT 'unknown',
  -- Whether we recognised the client or gave up. Makes "how many unknown clients are
  -- out there" answerable without re-running the guess.
  ADD COLUMN label_source text NOT NULL DEFAULT 'unrecognised'
    CHECK (label_source IN ('registration', 'unrecognised', 'manual'));

COMMENT ON COLUMN app.oauth_client.client_label IS
  'Immutable, set at registration. The person renames client_grant.display_name instead.';

/*
 * Freezes the identity after insert.
 *
 * A trigger rather than a convention, because the whole value of the column is that no
 * code path can change it. Dynamic client registration is open — Claude and ChatGPT
 * register themselves and there is no way around that — so the registration name is
 * attacker-controlled by construction. It may be read once.
 */
CREATE OR REPLACE FUNCTION app.freeze_client_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.client_label <> OLD.client_label
     OR NEW.agent_client <> OLD.agent_client
     OR NEW.client_id <> OLD.client_id THEN
    RAISE EXCEPTION 'app.oauth_client identity is immutable (client_id, client_label, agent_client)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER oauth_client_identity_frozen BEFORE UPDATE ON app.oauth_client
  FOR EACH ROW EXECUTE FUNCTION app.freeze_client_identity();

-- ---------------------------------------------------------------------------
-- Authorization requests parked while the person signs in
-- ---------------------------------------------------------------------------

CREATE TABLE app.oauth_pending_authorization (
  id             text PRIMARY KEY,
  client_id      text NOT NULL REFERENCES app.oauth_client (client_id) ON DELETE CASCADE,
  -- Copied rather than joined: this is shown on the login screen, and it must be the
  -- name as it was at the moment the request was validated.
  client_name    text NOT NULL,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  scope          text NOT NULL,
  state          text,
  resource       text,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_pending_expiry_idx ON app.oauth_pending_authorization (expires_at)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE app.oauth_pending_authorization IS
  'A validated authorize request, awaiting login. Redirect URI and PKCE are already fixed.';

-- ---------------------------------------------------------------------------
-- Lookups the token path needs
-- ---------------------------------------------------------------------------

-- Every authenticated request resolves a bearer token through this. It is the hottest
-- index in the schema and 0001 only had one on `person_id`.
CREATE UNIQUE INDEX oauth_token_access_idx ON app.oauth_token (token_hash);
CREATE UNIQUE INDEX oauth_token_refresh_idx ON app.oauth_token (refresh_hash)
  WHERE refresh_hash IS NOT NULL;

-- Reuse detection and "disconnect this client" both revoke a whole family, which the
-- schema defines as one client's chain of rotations for one person.
CREATE INDEX oauth_token_family_idx ON app.oauth_token (client_id, person_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- One row per person per client: the Klienter screen
-- ---------------------------------------------------------------------------

/*
 * Per person *and* per client rather than on the client row.
 *
 * A per-install client like Claude Desktop registers once per machine, so one
 * registration is one person. A hosted client is one registration for everybody. Keying
 * the grant on both means the same table is right in both cases, and it means a rename
 * or a revocation by one person can never touch another person's view of the same
 * client — which it would if `display_name` lived on `oauth_client`.
 */
CREATE TABLE app.client_grant (
  person_id     uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  client_id     text NOT NULL REFERENCES app.oauth_client (client_id) ON DELETE CASCADE,
  -- The person's own name for it. NULL means show `oauth_client.client_label`.
  display_name  text,
  -- Scope of the most recent authorization, so the screen can say what this client may
  -- do without joining live tokens.
  scope         text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Set by the person clicking "koppla bort". Distinct from having no live token: an
  -- expired token is a client that can come back, a revoked grant is one that cannot.
  revoked_at    timestamptz,
  PRIMARY KEY (person_id, client_id)
);

CREATE INDEX client_grant_person_idx ON app.client_grant (person_id, last_seen_at DESC);

COMMENT ON TABLE app.client_grant IS
  'What Klienter lists. Renameable by the person; revocable per client.';

/*
 * The daily write counter.
 *
 * Does not stop a single injected memory — the approval queue does that — but it bounds
 * the damage a loop or a taken-over client can do between the person noticing and
 * clicking revoke. It also gives the Klienter screen a number that means something.
 *
 * Keyed on the day rather than a rolling window: a person reading "142 skrivningar
 * idag" understands it, and a sliding window needs per-write rows to be accurate.
 */
CREATE TABLE app.client_write_counter (
  person_id uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES app.oauth_client (client_id) ON DELETE CASCADE,
  day       date NOT NULL,
  writes    integer NOT NULL DEFAULT 0 CHECK (writes >= 0),
  PRIMARY KEY (person_id, client_id, day)
);

/*
 * Counts a write and says whether it was within budget.
 *
 * One statement, for the same reason `app.reserve_storage` is: a read followed by an
 * increment lets a runaway client past a budget it has already exhausted.
 *
 * Returns the count *after* incrementing, so the caller refusing on `allowed = false`
 * and the screen showing `writes` agree about the same number.
 */
-- Output columns are named `counted_*` because a `RETURNS TABLE` column becomes a
-- plpgsql variable, and an output column called `day` or `writes` shadows the table
-- column of the same name inside the statement below — which Postgres reports as an
-- ambiguous reference rather than silently picking one.
CREATE OR REPLACE FUNCTION app.record_client_write(
  p_person_id uuid,
  p_client_id text,
  p_limit     integer
)
RETURNS TABLE (allowed boolean, counted_writes integer, counted_day date)
LANGUAGE plpgsql
AS $$
DECLARE
  v_day    date := (now() AT TIME ZONE 'UTC')::date;
  v_writes integer;
BEGIN
  INSERT INTO app.client_write_counter AS w (person_id, client_id, day, writes)
  VALUES (p_person_id, p_client_id, v_day, 1)
  ON CONFLICT (person_id, client_id, day)
  DO UPDATE SET writes = w.writes + 1
  RETURNING w.writes INTO v_writes;

  RETURN QUERY SELECT v_writes <= p_limit, v_writes, v_day;
END;
$$;

COMMENT ON FUNCTION app.record_client_write IS
  'Atomic per-client daily write budget. Counts first, then reports whether it fit.';

-- Old counters are noise once the day is over; the screen only ever reads today.
CREATE INDEX client_write_counter_day_idx ON app.client_write_counter (day);
