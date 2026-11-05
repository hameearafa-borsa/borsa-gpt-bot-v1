-- Durable queue for observed deals that have not yet been published.
-- Existing observations are historical/published records and are not re-queued.
CREATE TABLE IF NOT EXISTS deal_publication_queue (
  fingerprint TEXT NOT NULL REFERENCES deal_observations(fingerprint) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'published', 'expired')),
  first_queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (fingerprint, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_deal_publication_queue_pending
  ON deal_publication_queue(source, chat_id, first_queued_at)
  WHERE status = 'queued';
