-- Preserve parsed price type and optional list price on price-list rows.
-- Additive only: existing price-list data remains intact.
ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS unit_price_type TEXT;
ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS list_price NUMERIC(12,2);
