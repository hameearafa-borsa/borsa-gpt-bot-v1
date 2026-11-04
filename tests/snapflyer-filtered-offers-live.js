"use strict";

const assert = require("node:assert/strict");
const {
  FILTERS,
  collectSnapFlyerFilteredOffers
} = require("../modules/snapflyer-filtered-offers");

(async () => {
  const result = await collectSnapFlyerFilteredOffers({
    filters: FILTERS,
    concurrency: 1
  });

  const categoryCounts = result.deals.reduce((counts, deal) => {
    counts[deal.category] = (counts[deal.category] || 0) + 1;
    return counts;
  }, { detergent: 0, paper: 0, personal_care: 0 });

  console.log(JSON.stringify({
    test: "live_snapflyer_all_filtered_offers",
    sourceCount: result.sourceCount,
    sourceStats: result.sourceStats,
    errors: result.errors,
    extractedCount: result.deals.length,
    categoryCounts,
    merchants: [...new Set(result.deals.map(deal => deal.merchant).filter(Boolean))].sort(),
    sample: result.deals.slice(0, 20).map(deal => ({
      merchant: deal.merchant,
      title: deal.title,
      category: deal.category,
      price: deal.price,
      old_price: deal.old_price,
      discount_pct: deal.discount_pct,
      url: deal.url
    }))
  }, null, 2));

  assert.equal(result.sourceCount, FILTERS.length, "all nine SnapFlyer filters must be attempted");
  assert.equal(result.errors.length, 0, "all live SnapFlyer filter requests must complete without transport errors");
  assert.ok(result.deals.length > 0, "live SnapFlyer filters must yield at least one validated priced product");

  const allowedCategories = new Set(["detergent", "paper", "personal_care"]);
  for (const deal of result.deals) {
    assert.ok(allowedCategories.has(deal.category), "every offer must map to a newsletter category");
    assert.ok(deal.url.startsWith("https://snapflyer.io/"), "every extracted URL must remain on SnapFlyer HTTPS");
    assert.ok(Number.isFinite(deal.price) && deal.price > 0, "every extracted offer must have a positive numeric price");
    assert.ok(deal.title.length >= 3, "every extracted offer must have a readable product title");
  }

  const shavingFoam = result.deals.find(deal => /حلاقه|حلاقة|shaving/i.test(deal.title));
  if (shavingFoam) {
    assert.equal(shavingFoam.category, "personal_care", "live shaving products must be classified as personal care");
  }

  console.log("Live SnapFlyer all-filter test: OK");
})().catch(error => {
  console.error("Live SnapFlyer all-filter test: FAILED");
  console.error(error);
  process.exitCode = 1;
});
