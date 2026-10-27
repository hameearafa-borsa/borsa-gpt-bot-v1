-- Durable catalog fingerprints prevent repeated notifications for the same flyer version.
CREATE TABLE IF NOT EXISTS catalog_newsletter_snapshots (
  id BIGSERIAL PRIMARY KEY,
  store_key TEXT NOT NULL CHECK (store_key IN ('kazyon', 'bim', 'metro_market')),
  catalog_url TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'محافظة القاهرة',
  displayed_date_range TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'ignored', 'failed')),
  last_error TEXT,
  UNIQUE (store_key, catalog_url, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_catalog_newsletter_pending
  ON catalog_newsletter_snapshots(status, first_seen_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_catalog_newsletter_latest
  ON catalog_newsletter_snapshots(store_key, catalog_url, last_seen_at DESC);
