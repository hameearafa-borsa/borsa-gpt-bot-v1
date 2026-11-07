-- Keep retailer-advertised list price separate from the last different price observed by the bot.
ALTER TABLE deal_observations
  ADD COLUMN IF NOT EXISTS previous_observed_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS price_change_pct NUMERIC(12,2);
