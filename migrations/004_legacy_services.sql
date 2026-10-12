-- Additive migration for legacy protection, scheduled posts and moderation state.
-- Never drops or rewrites existing tables/data.
CREATE TABLE IF NOT EXISTS moderation_events (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  message_id BIGINT,
  user_id BIGINT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_moderation_events_chat_time ON moderation_events(chat_id,created_at DESC);
CREATE TABLE IF NOT EXISTS moderation_settings (
  chat_id BIGINT PRIMARY KEY,
  anti_spam_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  block_excessive_links BOOLEAN NOT NULL DEFAULT TRUE,
  max_links INTEGER NOT NULL DEFAULT 5 CHECK (max_links BETWEEN 1 AND 30),
  max_message_length INTEGER NOT NULL DEFAULT 5000 CHECK (max_message_length BETWEEN 500 AND 20000),
  block_untrusted_forwards BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS deal_publications (
  id BIGSERIAL PRIMARY KEY,
  batch_key TEXT NOT NULL,
  channel_kind TEXT NOT NULL CHECK (channel_kind IN ('amazon','other_sites','best_deals')),
  chat_id BIGINT NOT NULL,
  message_id BIGINT,
  item_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'prepared',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(batch_key,channel_kind)
);
CREATE TABLE IF NOT EXISTS bot_feature_settings (
  chat_id BIGINT NOT NULL,
  feature_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(chat_id,feature_key)
);
ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS product_label TEXT;
ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS variant_label TEXT;
ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS company_label TEXT;
ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS weight_g NUMERIC(12,3);
ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS volume_ml NUMERIC(12,3);
ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS wholesale_carton_price NUMERIC(12,2);
CREATE TABLE IF NOT EXISTS member_activity (
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  username TEXT,
  display_name TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_count BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY(chat_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_member_activity_last_seen ON member_activity(chat_id,last_seen_at DESC);
CREATE TABLE IF NOT EXISTS member_warnings (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  issued_by BIGINT NOT NULL,
  reason TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at TIMESTAMPTZ,
  cleared_by BIGINT
);
CREATE INDEX IF NOT EXISTS idx_member_warnings_active ON member_warnings(chat_id,user_id,active);
