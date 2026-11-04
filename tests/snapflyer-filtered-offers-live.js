"use strict";

const assert = require("node:assert/strict");
const {
  FILTERS,
  collectSnapFlyerFilteredOffers
} = require("../modules/snapflyer-filtered-offers");

(async () => {
  const filter = FILTERS.find(item => item.key === "laundry-detergent");
  assert.ok(filter, "laundry-detergent filter must exist");

  const result = await collectSnapFlyerFilteredOffers({
    filters: [filter],
    concurrency: 1
  });

  console.log(JSON.stringify({
    test: "live_snapflyer_filtered_offers",
    filter: filter.key,
    sourceCount: result.sourceCount,
    sourceStats: result.sourceStats,
    errors: result.errors,
    extractedCount: result.deals.length,
    sample: result.deals.slice(0, 12).map(deal => ({
      merchant: deal.merchant,
      title: deal.title,
      category: deal.category,
      price: deal.price,
      old_price: deal.old_price,
      discount_pct: deal.discount_pct,
      url: deal.url
    }))
  }, null, 2));

  assert.equal(result.errors.length, 0, "live SnapFlyer request must complete without transport errors");
  assert.ok(result.deals.length > 0, "live SnapFlyer page must yield at least one validated priced product");
  const shavingFoam = result.deals.find(deal => /حلاقه|حلاقة|shaving/i.test(deal.title));
  if (shavingFoam) assert.equal(shavingFoam.category, "personal_care", "live shaving products must be classified as personal care");
  for (const deal of result.deals) {
    assert.ok(deal.url.startsWith("https://snapflyer.io/"), "every extracted URL must remain on SnapFlyer HTTPS");
    assert.ok(Number.isFinite(deal.price) && deal.price > 0, "every extracted offer must have a positive numeric price");
    assert.ok(deal.title.length >= 3, "every extracted offer must have a readable product title");
  }

  console.log("Live SnapFlyer filtered-offer test: OK");
})().catch(error => {
  console.error("Live SnapFlyer filtered-offer test: FAILED");
  console.error(error);
  process.exitCode = 1;
});
