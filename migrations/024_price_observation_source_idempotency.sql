-- Prevent concurrent webhook retries from inserting the same source row twice.
-- Different Telegram messages remain distinct observations, even when their text is identical.
-- The partial index leaves manual/imported observations with missing source IDs unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_observations_source_row_unique
  ON price_observations (source_chat_id, source_message_id, (md5(raw_text)))
  WHERE source_chat_id IS NOT NULL
    AND source_message_id IS NOT NULL
    AND raw_text IS NOT NULL;
