-- Make Telegram source-message capture idempotent across webhook retries.
-- NULL source IDs remain allowed for non-Telegram/manual imports.
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_sources_telegram_message_unique
  ON merchant_sources (source_chat_id, source_message_id)
  WHERE source_chat_id IS NOT NULL AND source_message_id IS NOT NULL;
