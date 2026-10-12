-- Message cache enables /قائمة with a Telegram message link when the bot has already seen the source message.
CREATE TABLE IF NOT EXISTS observed_messages (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  user_id BIGINT,
  text TEXT,
  caption TEXT,
  message_type TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_observed_messages_lookup ON observed_messages(chat_id, message_id);
