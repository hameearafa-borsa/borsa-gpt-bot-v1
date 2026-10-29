-- Store the result of matching a live group observation to the latest compatible company reference.
-- Additive only; this does not change or delete historical prices.
ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS reference_observation_id BIGINT
    REFERENCES price_reference_observations(id) ON DELETE SET NULL;
ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS reference_price NUMERIC(12,2);
ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS reference_difference NUMERIC(12,2);
ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS reference_difference_percent NUMERIC(12,2);
ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS reference_comparison_status TEXT
    CHECK (reference_comparison_status IS NULL OR reference_comparison_status IN ('comparable', 'not_comparable'));
ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS reference_comparison_reason TEXT;
ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS reference_compared_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_price_observations_reference_match
  ON price_observations (reference_observation_id, reference_compared_at DESC)
  WHERE reference_observation_id IS NOT NULL;
