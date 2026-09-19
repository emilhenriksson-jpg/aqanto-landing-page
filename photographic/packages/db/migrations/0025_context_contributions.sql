-- A quiet preference, never a memory or a claim about the person.
CREATE TABLE app.context_contribution_preference (
  person_id uuid PRIMARY KEY REFERENCES app.person(id) ON DELETE CASCADE,
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON app.context_contribution_preference TO photographic_app;
CREATE INDEX proposal_context_contributions ON app.proposal (person_id, created_at)
  WHERE structured ? 'contribution';
