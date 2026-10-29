-- Preserve separately labelled and unlabelled price columns from a single source row.
-- Additive only: existing price observations and raw source text remain untouched.
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS listed_base_price NUMERIC(12,2);
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS explicit_wholesale_label_price NUMERIC(12,2);
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS price_selection_reason TEXT;
ALTER TABLE price_observations ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
