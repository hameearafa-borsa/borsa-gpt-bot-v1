-- Durable queue for observed deals that have not yet been published.
-- Existing observations are historical/published records and are not re-queued.
CREATE TABLE IF NOT EXISTS deal_publication_queue (
  fingerprint TEXT PRIMARY KEY REFERENCES deal_observations(fingerprint) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'published', 'expired')),
  first_queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deal_publication_queue_pending
  ON deal_publication_queue(source, first_queued_at)
  WHERE status = 'queued';
