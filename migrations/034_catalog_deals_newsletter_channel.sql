-- Add a separate daily publication channel for Metro, Kazyon and BIM catalog offers.
-- Existing publication records remain untouched.
ALTER TABLE deal_publications
  DROP CONSTRAINT IF EXISTS deal_publications_channel_kind_check;

ALTER TABLE deal_publications
  ADD CONSTRAINT deal_publications_channel_kind_check
  CHECK (channel_kind IN ('amazon', 'other_sites', 'best_deals', 'catalogs'));
