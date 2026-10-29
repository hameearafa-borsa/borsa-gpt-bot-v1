-- Preserve package form and free-extra weight in reviewer identity memory.
-- These dimensions can distinguish separate offers even when the product name is the same.
ALTER TABLE reviewed_price_products
  ADD COLUMN IF NOT EXISTS offer_extra_weight_g NUMERIC(12,3),
  ADD COLUMN IF NOT EXISTS package_type TEXT;
