-- Keep observation change labels aligned with the classifier in price-intelligence.js.
-- This is additive and safe for databases where migration 016 is already applied.
ALTER TABLE price_observations
  DROP CONSTRAINT IF EXISTS price_observations_change_type_check;

ALTER TABLE price_observations
  ADD CONSTRAINT price_observations_change_type_check
  CHECK (change_type IS NULL OR change_type IN (
    'new_observation',
    'price_change',
    'weight_change',
    'price_and_weight_change',
    'package_configuration_change',
    'price_and_package_configuration_change',
    'same_observation'
  ));
