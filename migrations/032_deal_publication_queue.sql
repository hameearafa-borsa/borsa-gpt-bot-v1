-- Durable per-group Amazon queue. Queue rows are retained until a confirmed Telegram publication.
-- Deliberately no expiry status, cascade delete, TTL, or automatic retirement on price changes.
CREATE TABLE IF NOT EXISTS deal_publication_queue (
  fingerprint TEXT NOT NULL REFERENCES deal_observations(fingerprint),
  chat_id BIGINT NOT NULL,
  source TEXT NOT NULL DEFAULT 'amazon',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'published')),
  first_queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (fingerprint, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_deal_publication_queue_fifo
  ON deal_publication_queue(source, chat_id, first_queued_at, fingerprint)
  WHERE status = 'queued';
