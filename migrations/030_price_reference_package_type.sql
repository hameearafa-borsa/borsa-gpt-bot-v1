-- Preserve package form in official references so live observations cannot match a different package identity.
ALTER TABLE price_reference_observations
  ADD COLUMN IF NOT EXISTS package_type TEXT;
