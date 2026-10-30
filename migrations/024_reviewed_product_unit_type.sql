-- Keep reviewer approval memory separate for per-piece and per-carton prices.
-- NULL preserves compatibility for older approvals whose unit was not recorded.
ALTER TABLE reviewed_price_products
  ADD COLUMN IF NOT EXISTS unit_price_type TEXT
  CHECK (unit_price_type IS NULL OR unit_price_type IN ('بالقطعة', 'بالكرتونة'));
