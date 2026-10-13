-- Additive weekly duplicate identity; preserves the existing observation fingerprint.
ALTER TABLE deal_observations ADD COLUMN IF NOT EXISTS product_fingerprint TEXT;
CREATE INDEX IF NOT EXISTS idx_deal_observations_product_recent
  ON deal_observations(product_fingerprint, observed_at DESC);
