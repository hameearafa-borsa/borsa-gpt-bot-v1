-- Allow one newsletter edition to be published independently to each approved group.
-- Preserve existing rows while replacing the former batch+kind uniqueness with per-chat uniqueness.
DO $$
DECLARE constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'deal_publications'::regclass
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM unnest(c.conkey) AS key_col(attnum)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key_col.attnum
      ) = ARRAY['batch_key','channel_kind']::text[]
  LOOP
    EXECUTE format('ALTER TABLE deal_publications DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_publications_batch_kind_chat
  ON deal_publications(batch_key, channel_kind, chat_id);
