-- V3 operational safeguards. Non-destructive.

CREATE TABLE IF NOT EXISTS processed_messages (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  update_type TEXT NOT NULL DEFAULT 'message',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id, message_id, update_type)
);

CREATE TABLE IF NOT EXISTS deal_observations (
  id BIGSERIAL PRIMARY KEY,
  merchant TEXT,
  title TEXT NOT NULL,
  url TEXT,
  category TEXT,
  price NUMERIC(12,2),
  old_price NUMERIC(12,2),
  discount_pct NUMERIC(6,2),
  fingerprint TEXT NOT NULL UNIQUE,
  source_chat_id BIGINT,
  source_message_id BIGINT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS authorized_chats (
  chat_id BIGINT PRIMARY KEY,
  chat_type TEXT NOT NULL,
  owner_user_id BIGINT,
  authorized_by BIGINT,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_processed_messages_time ON processed_messages(processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_observed ON deal_observations(observed_at DESC);
