-- Keep official company catalog prices comparable without conflating them with live group sightings.
-- Additive and safe for existing production data.
CREATE TABLE IF NOT EXISTS price_reference_observations (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES price_list_runs(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL DEFAULT 'company_catalog',
  company_label TEXT,
  source_period TEXT,
  declared_price_type TEXT,
  price_kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (price_kind IN ('wholesale', 'retail', 'unknown')),
  product_label TEXT,
  variant_label TEXT,
  weight_g NUMERIC(12,3),
  volume_ml NUMERIC(12,3),
  package_sale_price NUMERIC(12,2),
  wholesale_carton_price NUMERIC(12,2),
  consumer_price NUMERIC(12,2),
  pack_count INTEGER,
  unit_price_type TEXT,
  list_price NUMERIC(12,2),
  confidence NUMERIC(5,4),
  raw_line TEXT,
  decision TEXT NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_reference_product_period
  ON price_reference_observations (company_label, product_label, source_period);
CREATE INDEX IF NOT EXISTS idx_price_reference_kind_unit
  ON price_reference_observations (price_kind, unit_price_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_reference_run
  ON price_reference_observations (run_id);
