-- Preserve whether an observed wholesale amount is per piece or per carton.
-- Additive only; historical observations remain valid with an unknown unit.
ALTER TABLE price_observations
  ADD COLUMN IF NOT EXISTS unit_price_type TEXT
  CHECK (unit_price_type IS NULL OR unit_price_type IN ('بالقطعة', 'بالكرتونة'));
