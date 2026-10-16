-- Durable rate limiting for repeated deal-source failures.
-- Stores only a normalized error fingerprint and counters, never credentials.
CREATE TABLE IF NOT EXISTS deal_error_notifications (
  error_key TEXT PRIMARY KEY,
  occurrences BIGINT NOT NULL DEFAULT 1,
  last_notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
