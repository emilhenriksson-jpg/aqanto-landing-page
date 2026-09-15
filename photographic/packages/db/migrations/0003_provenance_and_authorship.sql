-- ---------------------------------------------------------------------------
-- Provenance, authorship, disputes, and the guarantees that belong in the database
--
-- Migration 0001 declared `app.event` the source of truth and 0002 gave it a narrow
-- redaction path. This one makes the claim load-bearing, and closes the gaps the
-- trust-and-permission review found.
--
-- Five groups of change.
--
-- **The log learns provenance.** Section 4 of the scope is a list of six questions every
-- memory has to answer: what, when we learned it, where from, which AI wrote it, where it
-- was stored, and why there. Four were already on the event. The two that were not --
-- where the information came from, and why it was stored *there* -- are the two nobody
-- can backfill, because they only exist at the instant of the write.
--
-- **Items learn who wrote them.** Author-bound deletion, "remove my contributions",
-- attribution after someone leaves, and recognising a contradiction across two people
-- rather than one, all need to answer "who wrote this" without joining a jsonb payload in
-- a permission check. The log stays the truth; this is a projection of `item.created`,
-- like `status` and `body` already are.
--
-- **Disagreement becomes a thing the schema can hold.** Two members of a room stating
-- incompatible facts is not a correction, and resolving it by recency means anyone in a
-- room can silently overwrite anyone else. Both statements stay active and carry each
-- other until a person decides. No new table: `disputed_by` is a projection of two new
-- event types.
--
-- **Two guarantees move out of code and into the database.** Nothing may be placed in a
-- shared room automatically, and a personal room may never acquire a second member. Both
-- were true only because no code path did it -- which is exactly the kind of rule an
-- admin feature or a migration script walks through later.
--
-- **The inert RLS policies go.** They read `photographic.person_id`, which no code has
-- ever set, so they protect nothing while looking like they protect something -- worse
-- than not having them. Build-plan decision 4 already chose: authorisation lives in the
-- API layer, one place, testable and portable, and room permissions are not duplicated
-- into RLS. `ARCHITECTURE.md` is corrected in the same change.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Provenance on the event
-- ---------------------------------------------------------------------------

ALTER TABLE app.event
  -- Why it happened, and why *there*. Short, human, Swedish, shown to the person as-is.
  ADD COLUMN motivation   text,
  -- Whether a person asked for this in so many words. Never null: the approval gate and
  -- the shared-room trigger both turn on it.
  ADD COLUMN explicit     boolean NOT NULL DEFAULT false,
  -- Where the information came from, before it was a memory. Distinct from
  -- `agent_client`: Claude writing down something you said and Claude pulling the same
  -- fact out of a PDF are one client and two origins, and only the second one answers
  -- "hur vet du det?".
  ADD COLUMN source_kind  text,   -- 'conversation' | 'document' | 'import' | 'manual' | 'unknown'
  ADD COLUMN source_label text,   -- 'Samtal med Claude', 'avtal.pdf'
  ADD COLUMN source_ref   text,   -- session ref, document id, import name
  ADD COLUMN source_uri   text,   -- a link back to the original, where one exists
  -- Provenance as a foreign key rather than a string. `agent_client` is derived from a
  -- name the client picked for itself, so it can say what kind of thing is calling and
  -- cannot say which one: a client could choose its own label in someone's history.
  -- Null until Track 3 moves the client store to Postgres, because an honest gap beats a
  -- confident guess.
  ADD COLUMN client_id    uuid REFERENCES app.oauth_client (id) ON DELETE SET NULL,
  -- Set on moves and shares. SET NULL rather than cascade: deleting a room must not take
  -- the record of what left it.
  ADD COLUMN from_room_id uuid REFERENCES app.room (id) ON DELETE SET NULL,
  ADD COLUMN to_room_id   uuid REFERENCES app.room (id) ON DELETE SET NULL;

ALTER TABLE app.event
  ADD CONSTRAINT event_source_kind_known CHECK (
    source_kind IS NULL
    OR source_kind IN ('conversation', 'document', 'import', 'manual', 'unknown')
  );

COMMENT ON COLUMN app.event.motivation IS
  'Human-readable reason, shown in the calendar. Redacted by app.purge_expired_items.';
COMMENT ON COLUMN app.event.client_id IS
  'The registered OAuth client that wrote this. Null means unknown, never a likely default.';

-- The calendar's only query shape: one room set, one day. `event_room_seq_idx` orders by
-- seq and `event_occurred_idx` ignores the room, so a day view would scan one of them in
-- full once per room the person belongs to.
CREATE INDEX event_room_day_idx ON app.event (room_id, occurred_at);

-- Zooming from an event to its source means "everything else that came out of this
-- session", which is a lookup by ref and nothing else.
CREATE INDEX event_source_ref_idx ON app.event (source_ref) WHERE source_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Authorship and disputes on the item
-- ---------------------------------------------------------------------------

ALTER TABLE app.item
  ADD COLUMN author_person_id uuid REFERENCES app.person (id),
  ADD COLUMN author_client_id uuid REFERENCES app.oauth_client (id) ON DELETE SET NULL,
  -- Item ids this one contradicts, unresolved. Symmetric: both sides carry each other.
  ADD COLUMN disputed_by      uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN placement_explicit boolean NOT NULL DEFAULT false;

-- Backfilled from the log, which has known the answer all along: the actor on the
-- `item.created` event. Anything the log cannot answer falls back to whoever owns the
-- room, which is true for every row this database can currently contain -- a room's
-- creator is its only member unless someone was invited, and invited members' writes all
-- carry an actor.
UPDATE app.item i
SET author_person_id = coalesce(
  (
    SELECT e.actor_person_id
    FROM app.event e
    WHERE e.event_type = 'item.created'
      AND e.payload ? 'item_id'
      AND (e.payload ->> 'item_id')::uuid = i.id
      AND e.actor_person_id IS NOT NULL
    ORDER BY e.seq
    LIMIT 1
  ),
  (SELECT r.created_by FROM app.room r WHERE r.id = i.room_id)
)
WHERE author_person_id IS NULL;

ALTER TABLE app.item
  ALTER COLUMN author_person_id SET NOT NULL;

COMMENT ON COLUMN app.item.author_person_id IS
  'Who wrote it. Projection of item.created; the author owns their own contribution in a shared room.';
COMMENT ON COLUMN app.item.disputed_by IS
  'Unresolved contradictions, symmetric. Projection of item.disputed / item.dispute_resolved.';
COMMENT ON COLUMN app.item.placement_explicit IS
  'A person asked for this memory to be in this room. Required for shared rooms.';

CREATE INDEX item_author_idx ON app.item (author_person_id, room_id);

-- Small and partial: almost nothing is ever disputed, and the queue needs to find the
-- few that are without reading the room.
CREATE INDEX item_disputed_idx ON app.item (room_id)
  WHERE disputed_by <> '{}'::uuid[];

-- Everything already in a shared room got there through the approval gate or an explicit
-- request, because that is the only path `requiresApproval` has ever allowed. Recording
-- it rather than leaving the default is what lets the trigger below apply to updates too.
UPDATE app.item i
SET placement_explicit = true
WHERE EXISTS (SELECT 1 FROM app.room r WHERE r.id = i.room_id AND r.kind = 'shared');

-- ---------------------------------------------------------------------------
-- Room isolation, enforced by the database
-- ---------------------------------------------------------------------------

/*
 * Nothing lands in a shared room unless a person put it there.
 *
 * A model deciding a private fact is relevant to a room five people read is the worst
 * failure available to this product: not wrong, which is recoverable, but disclosed,
 * which is not. Policy code refuses it in both implementations. This refuses the row, so
 * a future write path that forgets -- or a script run by hand at 02:00 -- fails loudly
 * instead of quietly telling four colleagues something private.
 *
 * `insufficient_privilege` rather than a check violation, because that is what the API
 * layer needs to hear to answer correctly.
 */
CREATE OR REPLACE FUNCTION app.reject_implicit_shared_placement() RETURNS trigger AS $$
DECLARE
  v_kind app.room_kind;
BEGIN
  SELECT kind INTO v_kind FROM app.room WHERE id = NEW.room_id;

  IF v_kind = 'shared' AND NOT NEW.placement_explicit THEN
    RAISE EXCEPTION
      'automatik får inte placera minnen i ett delat rum (rum %); delning är alltid en uttrycklig handling',
      NEW.room_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER item_shared_placement_explicit
  BEFORE INSERT OR UPDATE OF room_id, placement_explicit ON app.item
  FOR EACH ROW EXECUTE FUNCTION app.reject_implicit_shared_placement();

/*
 * A personal room structurally cannot acquire a second member.
 *
 * `invites.create` refuses `kind = 'personal'`, and that has been the only thing standing
 * between the personal room and a second reader. "The personal memory is never exposed
 * through a shared room" is the first sentence of the scope; it should be a property of
 * the database rather than a promise about code that does not exist yet.
 */
CREATE OR REPLACE FUNCTION app.reject_foreign_personal_membership() RETURNS trigger AS $$
DECLARE
  v_kind    app.room_kind;
  v_owner   uuid;
BEGIN
  SELECT kind, created_by INTO v_kind, v_owner FROM app.room WHERE id = NEW.room_id;

  IF v_kind = 'personal' AND NEW.person_id <> v_owner THEN
    RAISE EXCEPTION 'ett personligt rum kan bara ha sin egen ägare som medlem (rum %)', NEW.room_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER membership_personal_owner_only
  BEFORE INSERT OR UPDATE OF person_id, room_id ON app.membership
  FOR EACH ROW EXECUTE FUNCTION app.reject_foreign_personal_membership();

-- ---------------------------------------------------------------------------
-- Proposals can ask to share and to edit, not only to remember
-- ---------------------------------------------------------------------------

-- A model cannot write into a shared room. It can ask. Without this the only honest
-- answer to "dela det här med Elias" was a refusal, which loses the thing the approval
-- queue exists for: letting automation be useful about something it may not do alone.
ALTER TABLE app.proposal
  ADD COLUMN intent      text NOT NULL DEFAULT 'remember',
  ADD COLUMN source_item uuid REFERENCES app.item (id) ON DELETE CASCADE,
  -- Why this belongs where it is going, decided when the proposal was raised and carried
  -- onto the memory if it is accepted.
  --
  -- Distinct from `reason`, which says why we are *asking* — "delade rum ändras bara
  -- efter ditt godkännande" explains the queue, not the placement. Storing only the
  -- reason would mean the memory that eventually lands carries a sentence about approval
  -- where its explanation should be, and working the explanation out again at acceptance
  -- time, from a room list that may have changed since, is guessing.
  ADD COLUMN motivation  text;

ALTER TABLE app.proposal
  ADD CONSTRAINT proposal_intent_known CHECK (intent IN ('remember', 'share', 'update')),
  -- A share or an edit with nothing to act on is a proposal that cannot be accepted.
  ADD CONSTRAINT proposal_needs_source CHECK (
    intent = 'remember' OR source_item IS NOT NULL
  );

/*
 * Three references that could refuse a purge.
 *
 * `proposal.conflicts_with`, `proposal.resulting_item` and `item.superseded_by` all point
 * at `app.item` with no delete rule, which means a memory that any of them mentions
 * cannot be hard-deleted: the purge fails on a foreign key and the trash silently stops
 * keeping its promise. It is reachable as soon as a correction exists, because approving a
 * contradiction writes both a `conflicts_with` and a `superseded_by`.
 *
 * SET NULL rather than CASCADE in every case. These are pointers to something that no
 * longer exists, and the rows holding them are records of their own — a proposal keeps its
 * body and its reason, and a superseded memory stays superseded. Cascading would delete
 * the history of the decision along with the text it was about.
 */
ALTER TABLE app.proposal
  DROP CONSTRAINT IF EXISTS proposal_conflicts_with_fkey,
  ADD CONSTRAINT proposal_conflicts_with_fkey
    FOREIGN KEY (conflicts_with) REFERENCES app.item (id) ON DELETE SET NULL;

ALTER TABLE app.proposal
  DROP CONSTRAINT IF EXISTS proposal_resulting_item_fkey,
  ADD CONSTRAINT proposal_resulting_item_fkey
    FOREIGN KEY (resulting_item) REFERENCES app.item (id) ON DELETE SET NULL;

ALTER TABLE app.item
  DROP CONSTRAINT IF EXISTS item_superseded_by_fkey,
  ADD CONSTRAINT item_superseded_by_fkey
    FOREIGN KEY (superseded_by) REFERENCES app.item (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Purge: redact what the new columns hold
-- ---------------------------------------------------------------------------

/*
 * Same function as 0002 with three additions, each of them a leak that existed from the
 * moment the corresponding feature did.
 *
 *   - `previous` in the payload holds what a memory used to say. An edit keeps both
 *     values on purpose; a purge has to take both.
 *   - `motivation` is written by a model and can quote the memory it explains.
 *   - a correction records the replaced text under `previous` on the *new* item's event,
 *     so purging the old memory has to reach an event that is not about it. That one is
 *     surgical: the new memory's own body stays, only the quotation goes.
 */
CREATE OR REPLACE FUNCTION app.purge_expired_items(p_limit integer DEFAULT 500)
RETURNS integer AS $$
DECLARE
  v_ids   uuid[];
  v_count integer;
BEGIN
  SELECT array_agg(id) INTO v_ids
  FROM (
    SELECT id FROM app.item
    WHERE status = 'deleted'
      AND purge_after IS NOT NULL
      AND purge_after <= now()
    ORDER BY purge_after
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) due;

  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM set_config('app.redacting', 'on', true);

  -- Strip the text but keep the shape, so the feed can still say that something was
  -- remembered and then removed, without saying what it was.
  UPDATE app.event
  SET payload = (payload - 'body' - 'text' - 'structured' - 'excerpt' - 'previous')
                || jsonb_build_object('redacted', true, 'redacted_at', now()),
      motivation = NULL
  WHERE payload ? 'item_id'
    AND (payload ->> 'item_id')::uuid = ANY (v_ids);

  -- The quotation a correction kept of what it replaced.
  UPDATE app.event
  SET payload = (payload - 'previous') || jsonb_build_object('previous_redacted', true)
  WHERE payload ? 'supersedes'
    AND (payload ->> 'supersedes')::uuid = ANY (v_ids)
    AND payload ? 'previous';

  PERFORM set_config('app.redacting', 'off', true);

  DELETE FROM app.item WHERE id = ANY (v_ids);

  v_count := array_length(v_ids, 1);
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- The inert row-level security policies
-- ---------------------------------------------------------------------------

/*
 * Removed rather than connected.
 *
 * These policies gate on `app.current_person_id()`, which reads the session variable
 * `photographic.person_id`. No code has ever set it, so every policy has always been
 * evaluating NULL -- they have never denied anything and never allowed anything. A
 * defence that does nothing is worse than a missing one, because the next person to read
 * the schema will believe it is there.
 *
 * Connecting them for real would mean two authorities deciding room access, which
 * build-plan decision 4 rules out by name: authorisation stays in the API layer, one
 * place, testable, portable -- and that is also what makes "the architecture can be
 * swapped" an honest claim rather than a slogan. The guarantee is instead the choke point
 * (`app.accessible_room_ids`), the triggers above, and the tests.
 *
 * `app.current_person_id()` stays. It is harmless, and dropping a function nothing calls
 * is churn.
 */
DROP POLICY IF EXISTS item_member_read     ON app.item;
DROP POLICY IF EXISTS document_member_read ON app.document;
DROP POLICY IF EXISTS chunk_member_read    ON app.chunk;
DROP POLICY IF EXISTS brief_member_read    ON app.brief;
DROP POLICY IF EXISTS event_member_read    ON app.event;

ALTER TABLE app.item     DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.document DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.chunk    DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.brief    DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.event    DISABLE ROW LEVEL SECURITY;
