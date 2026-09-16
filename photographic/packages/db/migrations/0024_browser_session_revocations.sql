-- Store only SHA-256 hashes; a database read must not yield usable credentials.
CREATE TABLE app.browser_session_revocation (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX browser_session_revocation_expiry_idx
  ON app.browser_session_revocation (expires_at);
GRANT SELECT, INSERT, DELETE ON app.browser_session_revocation TO photographic_app;
