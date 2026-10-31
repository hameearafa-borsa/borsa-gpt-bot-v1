"use strict";

const { collectSnapFlyerCatalogDeals } = require("../modules/snapflyer-catalog-deals");

(async () => {
  const result = await collectSnapFlyerCatalogDeals({ now: new Date() });
  console.log("LIVE SNAPFLYER CATALOG TEXT EXTRACTION");
  console.log("Scope: Metro Market, BIM, Kazyon; current catalog page text only");
  console.log("No OCR, no product-image extraction, no individual product links.");
  for (const stat of result.sourceStats) {
    console.log(JSON.stringify({
      store: stat.source.replace(/^snapflyer_/, ""),
      ok: stat.ok,
      stage: stat.stage,
      extractedCount: stat.extractedCount,
      reason: stat.reason || null
    }));
  }
  for (const deal of result.deals) {
    console.log(JSON.stringify({
      merchant: deal.merchant,
      title: deal.title,
      priceEGP: deal.price,
      newsletterLink: deal.url,
      source: deal.source
    }));
    if (!/^https:\/\/snapflyer\.io\/eg\//.test(deal.url)) {
      throw new Error("Newsletter link is not a SnapFlyer catalog page");
    }
  }
  console.log("SUMMARY " + JSON.stringify({
    storesChecked: result.sourceCount,
    eligibleDeals: result.deals.length,
    fetchErrors: result.errors.length
  }));
  if (result.sourceCount !== 3) throw new Error("Expected exactly the three agreed catalog stores");
  if (result.errors.length) throw new Error("One or more live store/catalog fetches failed");
})().catch(error => {
  console.error("LIVE SNAPFLYER CATALOG TEXT EXTRACTION: FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
