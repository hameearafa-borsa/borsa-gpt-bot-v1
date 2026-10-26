-- Track catalog deliveries independently for each approved group.
-- Existing snapshot history is preserved; no prior deliveries are assumed for new groups.
CREATE TABLE IF NOT EXISTS catalog_newsletter_deliveries (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES catalog_newsletter_snapshots(id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'published', 'failed')),
  message_id BIGINT,
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_catalog_newsletter_deliveries_status
  ON catalog_newsletter_deliveries(status, snapshot_id);
