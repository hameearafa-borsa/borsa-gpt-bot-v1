-- Durable queue for interactive price review and identities explicitly approved as new products.
ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS review_reason TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by BIGINT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS price_review_queue (
  id BIGSERIAL PRIMARY KEY,
  observation_id BIGINT NOT NULL UNIQUE REFERENCES price_observations(id) ON DELETE CASCADE,
  source_chat_id BIGINT,
  log_chat_id BIGINT,
  log_message_id BIGINT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'ignored')),
  reviewed_by BIGINT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_price_review_queue_status_time
  ON price_review_queue(status, created_at DESC);

CREATE TABLE IF NOT EXISTS reviewed_price_products (
  identity_key TEXT PRIMARY KEY,
  product_text TEXT NOT NULL,
  weight_g NUMERIC(12,3),
  volume_ml NUMERIC(12,3),
  pack_count INTEGER,
  brand_key TEXT,
  approved_by BIGINT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
