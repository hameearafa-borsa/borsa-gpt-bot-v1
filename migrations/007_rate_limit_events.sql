-- Durable audit events for cross-replica rate-limit detection.
-- The unique message key makes retries idempotent; this remains audit-only.
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_recent
  ON rate_limit_events(chat_id, user_id, occurred_at DESC);
