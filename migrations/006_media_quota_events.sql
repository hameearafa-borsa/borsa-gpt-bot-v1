-- Durable, cross-replica audit counters for media quota detection.
-- One row per Telegram message prevents repeated updates from counting twice.
CREATE TABLE IF NOT EXISTS media_quota_events (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('photo','video')),
  quota_day DATE NOT NULL,
  message_id BIGINT NOT NULL,
  media_group_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_media_quota_daily
  ON media_quota_events(chat_id, user_id, quota_day, media_type);
