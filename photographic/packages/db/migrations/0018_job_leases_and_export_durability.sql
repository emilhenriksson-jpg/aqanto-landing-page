-- ---------------------------------------------------------------------------
-- Leases for background work, and an export that survives the machine it ran on.
--
-- The queue in 0001 claims a job by writing `locked_at` and nothing else. There is no
-- lease and no reaper, so a process that dies between claiming and finishing leaves the
-- row locked for as long as the database exists. On one Fly machine that restarts on
-- every deploy, the observable consequence is that profiles, briefs, embeddings, invite
-- expiry and document summaries stop updating — silently, because a locked row is
-- indistinguishable from a row someone is working on.
--
-- A lease makes the difference visible. A claim now says who took the job and until
-- when; whoever sweeps next may take a job whose lease has run out, and a job that
-- repeatedly outlives its lease exhausts `max_attempts` and fails where it can be seen
-- rather than looping forever.
--
-- Exports get the same treatment for the same reason, plus one of their own: an export
-- moved to `running` by a process that then died had no way back at all.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- app.job: leased claims
-- ---------------------------------------------------------------------------

ALTER TABLE app.job
  -- When the claim stops being believed. A worker holding a job past this has, as far as
  -- the queue is concerned, disappeared — which is exactly what a killed process looks
  -- like from here.
  ADD COLUMN lease_expires_at timestamptz,
  -- Extended while a handler is genuinely working. Distinguishes "this job takes eleven
  -- minutes" from "this job's process is gone", which a lease alone cannot.
  ADD COLUMN heartbeat_at     timestamptz;

COMMENT ON COLUMN app.job.locked_by IS
  'Which worker holds the claim: host, pid and a per-process id. Read when a lease expires.';
COMMENT ON COLUMN app.job.lease_expires_at IS
  'Claim deadline. A due job with a lapsed lease is reclaimable by any worker.';

-- Finding a reclaimable job. Partial on the claimed rows, which is the small side.
CREATE INDEX job_lease_idx ON app.job (lease_expires_at)
  WHERE locked_at IS NOT NULL AND failed_at IS NULL;

-- Queue depth and oldest-job age, which is what makes a stalled queue observable
-- instead of inferred. Covers the ready rows only, so it stays the size of the backlog.
CREATE INDEX job_ready_age_idx ON app.job (run_after)
  WHERE locked_at IS NULL AND failed_at IS NULL;

/*
 * Reclaims claims whose lease has lapsed.
 *
 * A function rather than a query in the application, because two things need it: the
 * sweep before every claim, and an operator asking what is stuck. `attempts` goes up on
 * reclaim, which is the part that matters — a job that kills its worker every time is a
 * poison job, and without counting the reclaim it would be retried until the end of the
 * world at whatever it cost to die.
 *
 * Rows past `max_attempts` are failed rather than reclaimed, with the reason recorded.
 * A failed row is visible in `app.job_stats`; a locked one was not visible anywhere.
 */
CREATE OR REPLACE FUNCTION app.reclaim_expired_jobs(p_limit integer DEFAULT 100)
RETURNS TABLE (id bigint, kind text, attempts integer, failed boolean)
LANGUAGE sql
AS $$
  WITH expired AS (
    SELECT j.id
    FROM app.job j
    WHERE j.locked_at IS NOT NULL
      AND j.failed_at IS NULL
      AND j.lease_expires_at IS NOT NULL
      AND j.lease_expires_at < now()
    ORDER BY j.lease_expires_at
    LIMIT greatest(p_limit, 0)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE app.job j
  SET attempts         = j.attempts + 1,
      locked_at        = NULL,
      locked_by        = NULL,
      lease_expires_at = NULL,
      heartbeat_at     = NULL,
      last_error       = coalesce(j.last_error, 'Arbetaren försvann innan jobbet blev klart.'),
      failed_at        = CASE WHEN j.attempts + 1 >= j.max_attempts THEN now() ELSE NULL END
  FROM expired e
  WHERE j.id = e.id
  RETURNING j.id, j.kind, j.attempts, j.failed_at IS NOT NULL;
$$;

COMMENT ON FUNCTION app.reclaim_expired_jobs IS
  'Frees jobs whose worker died. Counts the attempt, so a poison job fails visibly.';

/*
 * What the queue looks like right now.
 *
 * A view rather than four queries, because the four numbers are only meaningful
 * together: a depth of 300 is fine if the oldest is nine seconds old and is an incident
 * if it is nine hours old.
 */
CREATE OR REPLACE VIEW app.job_stats AS
  SELECT
    count(*) FILTER (
      WHERE locked_at IS NULL AND failed_at IS NULL
    )::bigint AS pending,
    count(*) FILTER (
      WHERE locked_at IS NULL AND failed_at IS NULL AND run_after <= now()
    )::bigint AS due,
    count(*) FILTER (WHERE locked_at IS NOT NULL AND failed_at IS NULL)::bigint AS running,
    count(*) FILTER (
      WHERE locked_at IS NOT NULL AND failed_at IS NULL AND lease_expires_at < now()
    )::bigint AS expired_leases,
    count(*) FILTER (WHERE failed_at IS NOT NULL)::bigint AS failed,
    min(run_after) FILTER (WHERE locked_at IS NULL AND failed_at IS NULL) AS oldest_pending_at,
    max(attempts) FILTER (WHERE failed_at IS NULL)::integer AS worst_attempts
  FROM app.job;

COMMENT ON VIEW app.job_stats IS
  'Queue depth, oldest waiting job, expired leases and failures. Read by /v1/ops/queue.';

-- ---------------------------------------------------------------------------
-- app.export_job: the same lease, and a way back from `running`
-- ---------------------------------------------------------------------------

ALTER TABLE app.export_job
  ADD COLUMN locked_by        text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN heartbeat_at     timestamptz,
  ADD COLUMN attempts         integer NOT NULL DEFAULT 0,
  -- Three, not five. Building an archive is expensive and a person is waiting: better to
  -- say "det gick inte, försök igen" on the third failure than to spend an hour of
  -- machine time discovering the same thing five times.
  ADD COLUMN max_attempts     integer NOT NULL DEFAULT 3,
  -- Written before the archive exists, so a crashed upload can be cleaned up by key
  -- rather than found by guessing. The object at this key is not to be trusted until
  -- `status = 'ready'`.
  ADD COLUMN pending_key      text;

COMMENT ON COLUMN app.export_job.lease_expires_at IS
  'Claim deadline. A running export past it is reclaimable, or failed once attempts run out.';
COMMENT ON COLUMN app.export_job.pending_key IS
  'Storage key a running build is writing to. Left behind by a crash; cleaned up on reclaim.';

CREATE INDEX export_job_lease_idx ON app.export_job (lease_expires_at)
  WHERE status = 'running';

CREATE OR REPLACE VIEW app.export_stats AS
  SELECT
    count(*) FILTER (WHERE status = 'pending')::bigint AS pending,
    count(*) FILTER (WHERE status = 'running')::bigint AS running,
    count(*) FILTER (
      WHERE status = 'running' AND lease_expires_at < now()
    )::bigint AS expired_leases,
    count(*) FILTER (WHERE status = 'failed')::bigint AS failed,
    count(*) FILTER (WHERE status = 'ready')::bigint AS ready,
    min(requested_at) FILTER (WHERE status = 'pending') AS oldest_pending_at
  FROM app.export_job;

COMMENT ON VIEW app.export_stats IS
  'Exports waiting, running, stuck and failed. An export nobody can see is a broken promise.';

-- ---------------------------------------------------------------------------
-- Download links: single use, short life
-- ---------------------------------------------------------------------------

/*
 * 0013 decided deliberately against single use, on the grounds that a multi-gigabyte
 * download failing halfway on a phone is the normal case and a one-shot link turns that
 * into "ask again and wait". That reasoning was about resumption, and it traded away too
 * much for it: the archive is the single most concentrated object in the product — one
 * file containing everything a person has ever told the system — and a seven-day link
 * that can be replayed, forwarded or scanned out of an inbox is a worse exposure than any
 * individual memory could be.
 *
 * So: single *successful* use, with a short window for an attempt that did not finish.
 *
 *   - `first_used_at` starts a grace window. Within it, a transfer that broke can be
 *     retried, which is the case 0013 was protecting.
 *   - `consumed_at` is written when a transfer completed. After that the token is dead,
 *     whatever the window says.
 *   - `expires_at` is now minted for an hour rather than a week, because a link is made
 *     on demand from a screen the person is already looking at.
 *
 * A spent link and a fictional one answer identically, exactly like a spent invite.
 */
ALTER TABLE app.export_download
  ADD COLUMN first_used_at timestamptz,
  ADD COLUMN consumed_at   timestamptz;

COMMENT ON COLUMN app.export_download.first_used_at IS
  'When the first transfer started. Opens a short window in which a broken one may resume.';
COMMENT ON COLUMN app.export_download.consumed_at IS
  'When a transfer completed. The link is spent from here on, and answers as unknown.';
COMMENT ON COLUMN app.export_download.use_count IS
  'Attempts, capped in the application. A shared link cannot be replayed indefinitely.';
