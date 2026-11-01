-- Store page-level OCR results with immutable catalog edition provenance.
CREATE TABLE IF NOT EXISTS catalog_ocr_pages (
  id BIGSERIAL PRIMARY KEY,
  store_key TEXT NOT NULL CHECK (store_key IN ('kazyon', 'bim', 'metro_market')),
  catalog_url TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  image_url TEXT NOT NULL,
  ocr_text TEXT NOT NULL DEFAULT '',
  character_count INTEGER NOT NULL DEFAULT 0 CHECK (character_count >= 0),
  engine TEXT NOT NULL DEFAULT 'tesseract',
  status TEXT NOT NULL CHECK (status IN ('extracted', 'empty', 'failed')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_key, catalog_url, fingerprint, page_number)
);
CREATE INDEX IF NOT EXISTS idx_catalog_ocr_pages_edition
  ON catalog_ocr_pages(store_key, catalog_url, fingerprint, page_number);
