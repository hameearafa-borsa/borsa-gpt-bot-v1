-- Persist the consumer-facing price independently from the selected wholesale price.
-- Additive only: old observations and raw source text remain unchanged.
ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS consumer_price NUMERIC(12,2);
