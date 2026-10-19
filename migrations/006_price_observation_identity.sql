-- Additive identity columns for silent price monitoring. Existing rows stay intact.
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS product_text TEXT;
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS weight_g NUMERIC(12,3);
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS volume_ml NUMERIC(12,3);
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS pack_count INTEGER;
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS offer_extra_weight_g NUMERIC(12,3);
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'accepted';
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS brand_key TEXT;
CREATE INDEX IF NOT EXISTS idx_price_obs_decision_time ON price_observations(decision, observed_at DESC);
