-- V3 foundation. Non-destructive: creates only new tables/indexes.

CREATE TABLE IF NOT EXISTS merchant_sources (
  id BIGSERIAL PRIMARY KEY,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  source_chat_id BIGINT,
  source_message_id BIGINT,
  source_user_id BIGINT,
  source_type TEXT NOT NULL DEFAULT 'telegram',
  raw_text TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS merchant_history (
  id BIGSERIAL PRIMARY KEY,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name TEXT,
  activity TEXT,
  location TEXT,
  phone TEXT,
  telegram_username TEXT,
  source_id BIGINT REFERENCES merchant_sources(id) ON DELETE SET NULL,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS product_companies (
  id BIGSERIAL PRIMARY KEY,
  name_ar TEXT NOT NULL UNIQUE,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_brands (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES product_companies(id) ON DELETE SET NULL,
  name_ar TEXT NOT NULL UNIQUE,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_families (
  id BIGSERIAL PRIMARY KEY,
  brand_id BIGINT NOT NULL REFERENCES product_brands(id) ON DELETE CASCADE,
  name_ar TEXT NOT NULL,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (brand_id, name_ar)
);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  family_id BIGINT REFERENCES product_families(id) ON DELETE SET NULL,
  brand_id BIGINT REFERENCES product_brands(id) ON DELETE SET NULL,
  company_id BIGINT REFERENCES product_companies(id) ON DELETE SET NULL,
  name_ar TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  category TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (normalized_name)
);

CREATE TABLE IF NOT EXISTS product_variants (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_type TEXT,
  weight_g NUMERIC(12,3),
  package_type TEXT,
  pack_count INTEGER,
  label_weight_g NUMERIC(12,3),
  offer_extra_weight_g NUMERIC(12,3),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_observations (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  variant_id BIGINT REFERENCES product_variants(id) ON DELETE SET NULL,
  merchant_id INTEGER REFERENCES merchants(id) ON DELETE SET NULL,
  price_kind TEXT NOT NULL,
  package_sale_price NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EGP',
  source_chat_id BIGINT,
  source_message_id BIGINT,
  source_user_id BIGINT,
  raw_text TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confidence NUMERIC(5,4),
  is_duplicate BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS price_list_runs (
  id BIGSERIAL PRIMARY KEY,
  merchant_id INTEGER REFERENCES merchants(id) ON DELETE SET NULL,
  source_chat_id BIGINT,
  source_message_id BIGINT,
  raw_text TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  extracted_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_list_items (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES price_list_runs(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  variant_id BIGINT REFERENCES product_variants(id) ON DELETE SET NULL,
  package_sale_price NUMERIC(12,2),
  consumer_price NUMERIC(12,2),
  pack_count INTEGER,
  confidence NUMERIC(5,4),
  raw_line TEXT,
  decision TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS chemical_knowledge (
  id BIGSERIAL PRIMARY KEY,
  subject_key TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  kind TEXT,
  function_ar TEXT,
  safety_notes TEXT,
  incompatibilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT,
  reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS diagnostic_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  module TEXT NOT NULL,
  stage TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  status TEXT NOT NULL DEFAULT 'ok',
  input_summary TEXT,
  input_fingerprint TEXT,
  details JSONB,
  duration_ms INTEGER,
  chat_id BIGINT,
  message_id BIGINT
);

CREATE INDEX IF NOT EXISTS idx_price_obs_product_time ON price_observations(product_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_obs_merchant_time ON price_observations(merchant_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_merchant_sources_merchant_time ON merchant_sources(merchant_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnostic_events_time ON diagnostic_events(ts DESC);
