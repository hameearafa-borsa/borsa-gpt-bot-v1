-- Keep publication channel kinds aligned with the newsletter editions emitted by deal-scheduler.
-- Preserve every known historical and current value so existing publication history remains valid.
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
    'market_stores_2'
  ));
