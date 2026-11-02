-- Keep explicit package wording separate from the product name and link live sightings
-- to the official catalog row that established their identity.
ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS package_description TEXT;

ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS reference_observation_id BIGINT
  REFERENCES price_reference_observations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_price_observations_reference_observation
  ON price_observations(reference_observation_id)
  WHERE reference_observation_id IS NOT NULL;
