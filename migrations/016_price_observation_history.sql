-- Additive historical price-intelligence fields. Existing observations are preserved.
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS package_type TEXT;
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS product_identity_key TEXT;
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS change_type TEXT
  CHECK (change_type IS NULL OR change_type IN (
    'new_observation',
    'price_change',
    'weight_change',
    'price_and_weight_change',
    'same_observation'
  ));

CREATE INDEX IF NOT EXISTS idx_price_observations_identity_history
  ON price_observations(product_identity_key, price_kind, observed_at DESC, id DESC)
  WHERE decision = 'accepted' AND product_identity_key IS NOT NULL;
