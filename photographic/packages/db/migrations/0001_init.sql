-- Photographic core schema.
--
-- Two invariants govern every table here:
--   1. `person` is the root object. There is no tenant/org table and there never will be:
--      a person joins rooms directly, so `person_id` stays a stable shard key.
--   2. `event` is the only source of truth for memory mutations. `item`, `profile`,
--      `brief` and `chunk.embedding` are projections that can be rebuilt by replaying it.
--      Never UPDATE or DELETE a row in `event`.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE app.room_kind AS ENUM ('personal', 'shared');
CREATE TYPE app.member_role AS ENUM ('owner', 'editor', 'viewer');
CREATE TYPE app.invite_status AS ENUM ('pending', 'accepted', 'revoked', 'expired');

-- `instruction` changes how every connected model behaves, so it is separated from
-- `fact` at the type level: instructions are rendered into system-prompt position and
-- always require explicit human approval.
CREATE TYPE app.item_kind AS ENUM (
  'identity',     -- who the person is: name, family, location, role
  'fact',         -- durable factual statement: "allergic to ketchup"
  'preference',   -- soft preference: "prefers short answers"
  'instruction',  -- behavioural directive: "always challenge my ideas"
  'decision',     -- a decision reached, usually in a shared room
  'note',         -- free-form content
  'never'         -- explicit negative constraint: "never assume I drive"
);

CREATE TYPE app.item_status AS ENUM ('active', 'superseded', 'archived', 'deleted');

-- `local_only` is not enforced yet. It exists so that client-side encrypted rooms can be
-- introduced later without a data migration; server-side projection must skip these.
CREATE TYPE app.sensitivity AS ENUM ('normal', 'sensitive', 'local_only');

CREATE TYPE app.proposal_status AS ENUM ('pending', 'accepted', 'rejected', 'expired');

-- Write tiering. See docs/policy.md: small non-contradicting facts land as `auto`,
-- anything that contradicts existing state or is an instruction becomes a proposal.
CREATE TYPE app.write_decision AS ENUM ('auto', 'needs_approval', 'rejected_duplicate');

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- A person owns their identity. External providers (Google, Apple, BankID) attach as
-- credentials; the person id is never an external subject.
CREATE TABLE app.person (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle          text UNIQUE,
  display_name    text,
  email           citext,
  phone           text,
  locale          text NOT NULL DEFAULT 'sv-SE',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE UNIQUE INDEX person_email_key ON app.person (email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX person_phone_key ON app.person (phone) WHERE deleted_at IS NULL;

CREATE TABLE app.credential (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  provider        text NOT NULL,          -- 'password' | 'google' | 'apple' | 'email_otp' | 'sms_otp'
  subject         text NOT NULL,          -- provider-local identifier
  secret_hash     text,                   -- only for 'password'
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  UNIQUE (provider, subject)
);

CREATE INDEX credential_person_idx ON app.credential (person_id);

-- ---------------------------------------------------------------------------
-- Rooms and membership
-- ---------------------------------------------------------------------------

-- The personal room is NOT a special case: it is a room with kind='personal' and one
-- member, created automatically at signup. One code path, not two.
CREATE TABLE app.room (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            app.room_kind NOT NULL,
  slug            text NOT NULL,
  title           text NOT NULL,
  description     text,
  sensitivity     app.sensitivity NOT NULL DEFAULT 'normal',
  created_by      uuid NOT NULL REFERENCES app.person (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);

-- Exactly one personal room per person, enforced in the database rather than in code.
CREATE UNIQUE INDEX room_one_personal_per_person
  ON app.room (created_by)
  WHERE kind = 'personal';

CREATE INDEX room_created_by_idx ON app.room (created_by);

CREATE TABLE app.membership (
  person_id       uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  room_id         uuid NOT NULL REFERENCES app.room (id) ON DELETE CASCADE,
  role            app.member_role NOT NULL,
  invited_by      uuid REFERENCES app.person (id),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  PRIMARY KEY (person_id, room_id)
);

CREATE INDEX membership_room_idx ON app.membership (room_id) WHERE left_at IS NULL;
CREATE INDEX membership_person_idx ON app.membership (person_id) WHERE left_at IS NULL;

CREATE TABLE app.invite (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         uuid NOT NULL REFERENCES app.room (id) ON DELETE CASCADE,
  invited_by      uuid NOT NULL REFERENCES app.person (id),
  channel         text NOT NULL,          -- 'email' | 'sms'
  destination     text NOT NULL,
  role            app.member_role NOT NULL DEFAULT 'editor',
  token_hash      text NOT NULL UNIQUE,   -- the raw token is only ever in the sent link
  status          app.invite_status NOT NULL DEFAULT 'pending',
  -- Recipients can preview room content before creating an account; the viral loop dies
  -- if the first step is a signup wall.
  preview_allowed boolean NOT NULL DEFAULT true,
  expires_at      timestamptz NOT NULL,
  accepted_by     uuid REFERENCES app.person (id),
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invite_room_idx ON app.invite (room_id);
CREATE INDEX invite_status_idx ON app.invite (status) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Event log: append-only source of truth
-- ---------------------------------------------------------------------------

CREATE TABLE app.event (
  seq             bigserial PRIMARY KEY,
  id              uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  room_id         uuid NOT NULL REFERENCES app.room (id) ON DELETE CASCADE,
  event_type      text NOT NULL,          -- 'item.created' | 'item.superseded' | 'item.deleted' | ...
  payload         jsonb NOT NULL,
  -- Provenance. This is the one thing that cannot be backfilled, so it is NOT NULL
  -- wherever it possibly can be.
  actor_person_id uuid REFERENCES app.person (id),
  agent_client    text,                   -- 'claude-desktop' | 'chatgpt-web' | 'voice' | 'web' | 'cursor'
  session_ref     text,
  approved_by     uuid REFERENCES app.person (id),
  approved_at     timestamptz,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX event_room_seq_idx ON app.event (room_id, seq);
CREATE INDEX event_occurred_idx ON app.event (occurred_at);
CREATE INDEX event_payload_idx ON app.event USING gin (payload jsonb_path_ops);

-- Enforce append-only at the database level, not by convention.
CREATE OR REPLACE FUNCTION app.reject_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'app.event is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_no_update BEFORE UPDATE ON app.event
  FOR EACH ROW EXECUTE FUNCTION app.reject_event_mutation();
CREATE TRIGGER event_no_delete BEFORE DELETE ON app.event
  FOR EACH ROW EXECUTE FUNCTION app.reject_event_mutation();

-- ---------------------------------------------------------------------------
-- Item: the projection people actually read
-- ---------------------------------------------------------------------------

CREATE TABLE app.item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short, human-speakable handle so a model can say forget('p-7k2m') instead of
  -- matching on free text. Deleting the wrong memory costs you the user.
  short_id        text NOT NULL,
  room_id         uuid NOT NULL REFERENCES app.room (id) ON DELETE CASCADE,
  kind            app.item_kind NOT NULL,
  body            text NOT NULL,
  structured      jsonb NOT NULL DEFAULT '{}'::jsonb,
  sensitivity     app.sensitivity NOT NULL DEFAULT 'normal',
  status          app.item_status NOT NULL DEFAULT 'active',

  -- Temporal validity. Preferences change; without this the model still thinks you
  -- live where you lived two years ago.
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  superseded_by   uuid REFERENCES app.item (id),

  -- Budget packing and eviction from the always-injected profile.
  salience        real NOT NULL DEFAULT 0.5,
  token_estimate  integer NOT NULL DEFAULT 0,
  last_used_at    timestamptz,
  use_count       integer NOT NULL DEFAULT 0,

  -- Deduplication across models: ChatGPT and Claude will both try to save
  -- "allergic to ketchup". Normalised text hash catches the exact case, the embedding
  -- catches the paraphrase.
  dedupe_hash     text,
  embedding       vector(1536),

  created_event   bigint REFERENCES app.event (seq),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (room_id, short_id)
);

CREATE INDEX item_room_active_idx ON app.item (room_id, kind)
  WHERE status = 'active';
CREATE UNIQUE INDEX item_dedupe_idx ON app.item (room_id, dedupe_hash)
  WHERE status = 'active' AND dedupe_hash IS NOT NULL;
CREATE INDEX item_body_trgm_idx ON app.item USING gin (body gin_trgm_ops);
CREATE INDEX item_fts_idx ON app.item
  USING gin (to_tsvector('simple', body));
CREATE INDEX item_embedding_idx ON app.item
  USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

CREATE TABLE app.document (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         uuid NOT NULL REFERENCES app.room (id) ON DELETE CASCADE,
  filename        text NOT NULL,
  mime_type       text NOT NULL,
  byte_size       bigint NOT NULL,
  storage_key     text NOT NULL,
  checksum        text NOT NULL,
  uploaded_by     uuid NOT NULL REFERENCES app.person (id),
  extracted_at    timestamptz,
  summary         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_room_idx ON app.document (room_id);

-- room_id is denormalised onto chunk so the permission filter is a single join.
-- Post-filtering retrieval results is how rooms leak into each other.
CREATE TABLE app.chunk (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES app.document (id) ON DELETE CASCADE,
  room_id         uuid NOT NULL REFERENCES app.room (id) ON DELETE CASCADE,
  ord             integer NOT NULL,
  text            text NOT NULL,
  token_estimate  integer NOT NULL DEFAULT 0,
  embedding       vector(1536),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, ord)
);

CREATE INDEX chunk_room_idx ON app.chunk (room_id);
CREATE INDEX chunk_fts_idx ON app.chunk USING gin (to_tsvector('simple', text));
CREATE INDEX chunk_embedding_idx ON app.chunk
  USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Projections: profile and brief
-- ---------------------------------------------------------------------------

-- The personal profile is never retrieved by search. It is injected whole, every time.
-- That is why it has a hard token ceiling instead of a relevance ranking.
CREATE TABLE app.profile (
  person_id       uuid PRIMARY KEY REFERENCES app.person (id) ON DELETE CASCADE,
  rendered        text NOT NULL DEFAULT '',
  sections        jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_count     integer NOT NULL DEFAULT 0,
  item_count      integer NOT NULL DEFAULT 0,
  built_from_seq  bigint NOT NULL DEFAULT 0,
  version         integer NOT NULL DEFAULT 1,
  built_at        timestamptz NOT NULL DEFAULT now()
);

-- Rooms get a rolling summary, regenerated asynchronously. Building this on demand at
-- session start makes voice latency impossible.
CREATE TABLE app.brief (
  room_id         uuid PRIMARY KEY REFERENCES app.room (id) ON DELETE CASCADE,
  rendered        text NOT NULL DEFAULT '',
  token_count     integer NOT NULL DEFAULT 0,
  built_from_seq  bigint NOT NULL DEFAULT 0,
  stale           boolean NOT NULL DEFAULT true,
  version         integer NOT NULL DEFAULT 1,
  built_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX brief_stale_idx ON app.brief (stale) WHERE stale;

-- "What happened since you were last here" is the single strongest feeling in the
-- product, and it needs exactly one column to work.
CREATE TABLE app.room_read_state (
  person_id       uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  room_id         uuid NOT NULL REFERENCES app.room (id) ON DELETE CASCADE,
  last_seen_seq   bigint NOT NULL DEFAULT 0,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, room_id)
);

-- ---------------------------------------------------------------------------
-- Proposals: the approval queue
-- ---------------------------------------------------------------------------

CREATE TABLE app.proposal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         uuid NOT NULL REFERENCES app.room (id) ON DELETE CASCADE,
  person_id       uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  kind            app.item_kind NOT NULL,
  body            text NOT NULL,
  reason          text NOT NULL,          -- why approval was required
  conflicts_with  uuid REFERENCES app.item (id),
  proposed_by_client text,
  status          app.proposal_status NOT NULL DEFAULT 'pending',
  resolved_at     timestamptz,
  resulting_item  uuid REFERENCES app.item (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX proposal_pending_idx ON app.proposal (person_id, created_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Client sessions and the "did it actually read the profile" signal
-- ---------------------------------------------------------------------------

-- We cannot force every client to read the personal room. So we measure it and show
-- the user, per client, whether it happened. Transparency is the only honest promise
-- available here.
CREATE TABLE app.client_session (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  agent_client      text NOT NULL,
  transport         text NOT NULL,        -- 'mcp' | 'rest' | 'realtime' | 'hook' | 'web'
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  profile_delivered boolean NOT NULL DEFAULT false,
  profile_version   integer,
  delivery_method   text                  -- 'mcp_instructions' | 'tool_call' | 'system_prompt' | 'hook'
);

CREATE INDEX client_session_person_idx ON app.client_session (person_id, started_at DESC);

CREATE TABLE app.access_log (
  id              bigserial PRIMARY KEY,
  person_id       uuid REFERENCES app.person (id) ON DELETE SET NULL,
  room_id         uuid REFERENCES app.room (id) ON DELETE SET NULL,
  session_id      uuid REFERENCES app.client_session (id) ON DELETE SET NULL,
  agent_client    text,
  action          text NOT NULL,          -- 'read' | 'search' | 'write' | 'delete' | 'bundle'
  item_ids        uuid[],
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX access_log_person_idx ON app.access_log (person_id, occurred_at DESC);
CREATE INDEX access_log_room_idx ON app.access_log (room_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- OAuth 2.1 authorization server
-- ---------------------------------------------------------------------------

-- We run our own authorization server because both ChatGPT and Claude register
-- dynamically (DCR / CIMD) and each person must hold their own token. A shared API key
-- would collapse the entire room permission model.
CREATE TABLE app.oauth_client (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           text NOT NULL UNIQUE,
  client_secret_hash  text,               -- null for public clients using PKCE
  client_name         text NOT NULL,
  redirect_uris       text[] NOT NULL,
  grant_types         text[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
  token_endpoint_auth text NOT NULL DEFAULT 'none',
  registered_via      text NOT NULL DEFAULT 'dcr',  -- 'dcr' | 'cimd' | 'manual'
  cimd_url            text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.oauth_authorization (
  code_hash           text PRIMARY KEY,
  client_id           text NOT NULL REFERENCES app.oauth_client (client_id) ON DELETE CASCADE,
  person_id           uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  redirect_uri        text NOT NULL,
  code_challenge      text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  scope               text NOT NULL,
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.oauth_token (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash          text NOT NULL UNIQUE,
  refresh_hash        text UNIQUE,
  client_id           text NOT NULL REFERENCES app.oauth_client (client_id) ON DELETE CASCADE,
  person_id           uuid NOT NULL REFERENCES app.person (id) ON DELETE CASCADE,
  scope               text NOT NULL,
  -- Tokens may be narrowed to specific rooms. Empty array means "all rooms the person
  -- is a member of", resolved at request time, never cached into the token.
  room_scope          uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  last_used_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_token_person_idx ON app.oauth_token (person_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Job queue (Postgres is the queue; no Redis, no Kafka)
-- ---------------------------------------------------------------------------

CREATE TABLE app.job (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL,          -- 'rebuild_profile' | 'rebuild_brief' | 'embed_item' | ...
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key      text,
  run_after       timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  locked_at       timestamptz,
  locked_by       text,
  failed_at       timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX job_dedupe_idx ON app.job (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND locked_at IS NULL AND failed_at IS NULL;
CREATE INDEX job_ready_idx ON app.job (kind, run_after)
  WHERE locked_at IS NULL AND failed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Permission resolution: the single choke point
-- ---------------------------------------------------------------------------

-- Every read path resolves access through this function. Not a pattern everyone
-- follows -- an actual function. Two places deciding access is how you leak.
CREATE OR REPLACE FUNCTION app.accessible_room_ids(p_person_id uuid)
RETURNS TABLE (room_id uuid, role app.member_role)
LANGUAGE sql
STABLE
AS $$
  SELECT m.room_id, m.role
  FROM app.membership m
  JOIN app.room r ON r.id = m.room_id
  WHERE m.person_id = p_person_id
    AND m.left_at IS NULL
    AND r.archived_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION app.can_read_room(p_person_id uuid, p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.accessible_room_ids(p_person_id) a WHERE a.room_id = p_room_id
  );
$$;

CREATE OR REPLACE FUNCTION app.can_write_room(p_person_id uuid, p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.accessible_room_ids(p_person_id) a
    WHERE a.room_id = p_room_id AND a.role IN ('owner', 'editor')
  );
$$;

-- ---------------------------------------------------------------------------
-- Row-level security: the second line of defence behind application checks
-- ---------------------------------------------------------------------------

-- The application always filters by membership. RLS exists so that a missed filter is
-- an empty result set rather than someone else's private life.

CREATE OR REPLACE FUNCTION app.current_person_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('photographic.person_id', true), '')::uuid;
$$;

ALTER TABLE app.item     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.document ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chunk    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.brief    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.event    ENABLE ROW LEVEL SECURITY;

CREATE POLICY item_member_read ON app.item FOR SELECT
  USING (app.can_read_room(app.current_person_id(), room_id));
CREATE POLICY document_member_read ON app.document FOR SELECT
  USING (app.can_read_room(app.current_person_id(), room_id));
CREATE POLICY chunk_member_read ON app.chunk FOR SELECT
  USING (app.can_read_room(app.current_person_id(), room_id));
CREATE POLICY brief_member_read ON app.brief FOR SELECT
  USING (app.can_read_room(app.current_person_id(), room_id));
CREATE POLICY event_member_read ON app.event FOR SELECT
  USING (app.can_read_room(app.current_person_id(), room_id));

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER person_touch BEFORE UPDATE ON app.person
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER room_touch BEFORE UPDATE ON app.room
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER item_touch BEFORE UPDATE ON app.item
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
