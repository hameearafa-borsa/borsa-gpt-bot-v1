-- Expiring notification leases prevent concurrent bot instances from sending duplicate review messages.
ALTER TABLE price_review_queue
  ADD COLUMN IF NOT EXISTS notification_claim_token TEXT,
  ADD COLUMN IF NOT EXISTS notification_claimed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_price_review_queue_notification_lease
  ON price_review_queue(status, notification_claimed_at)
  WHERE log_message_id IS NULL;
