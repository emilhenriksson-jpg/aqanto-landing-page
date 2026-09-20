-- Private provider app identities belong to one person's authorized connection.
-- This is launch metadata only; it grants no permission and contains no credentials.
ALTER TABLE app.client_grant ADD COLUMN chatgpt_plugin_id text
  CHECK (chatgpt_plugin_id IS NULL OR chatgpt_plugin_id ~ '^dev-[a-f0-9]{32}@openai-curated-remote$');
