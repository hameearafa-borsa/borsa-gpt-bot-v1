-- Persistent, scoped service controls. Global settings use chat_id=0;
-- group settings use the negative Telegram group/supergroup ID.
CREATE TABLE IF NOT EXISTS service_settings (
  scope TEXT NOT NULL CHECK (scope IN ('global','group')),
  chat_id BIGINT NOT NULL,
  service_key TEXT NOT NULL CHECK (service_key IN ('chemical','prices','lists','merchants','deals','catalogs','weather','economic')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(scope,chat_id,service_key),
  CHECK ((scope='global' AND chat_id=0) OR (scope='group' AND chat_id<0))
);
CREATE INDEX IF NOT EXISTS idx_service_settings_group
  ON service_settings(chat_id,service_key) WHERE scope='group';
