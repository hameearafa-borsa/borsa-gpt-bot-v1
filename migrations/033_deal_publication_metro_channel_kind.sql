-- Add the direct Metro newsletter edition to the publication channel allowlist.
-- Keep all historical and currently scheduled newsletter kinds valid.
ALTER TABLE deal_publications
  DROP CONSTRAINT IF EXISTS deal_publications_channel_kind_check;

ALTER TABLE deal_publications
  ADD CONSTRAINT deal_publications_channel_kind_check
  CHECK (channel_kind IN (
    'amazon',
    'catalogs',
    'other_sites',
    'best_deals',
    'online_stores',
    'market_stores',
    'market_stores_2',
    'metro_stores'
  ));
