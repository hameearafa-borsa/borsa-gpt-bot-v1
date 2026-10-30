"use strict";

// One-request-per-retailer live diagnostic. No Telegram, database, or publishing.
const dotenvPath = process.env.DOTENV_CONFIG_PATH;
require("dotenv").config(dotenvPath ? { path: dotenvPath } : undefined);
const { fetchSearch } = require("../modules/deal-sources");

const sources = [
  { name: "jumia", query: "مسحوق غسيل منظف" },
  { name: "noon", query: "مسحوق غسيل منظف" },
  { name: "carrefour", query: "" }
];

(async () => {
  if (!String(process.env.SCRAPER_API_KEY || "").trim()) {
    console.error("BLOCKED: SCRAPER_API_KEY is not configured.");
    process.exitCode = 2;
    return;
  }

  // Force exactly one credential and therefore at most one HTTP request per retailer.
  const backupKey = process.env.SCRAPER_API_KEY_2;
  delete process.env.SCRAPER_API_KEY_2;
  const report = [];
  try {
    for (const source of sources) {
      const startedAt = Date.now();
      const result = await fetchSearch(source.name, source.query, { timeoutMs: 25000 });
      const deals = Array.isArray(result.deals) ? result.deals : [];
      const entry = {
        source: source.name,
        query: source.query || "(retailer offers page)",
        elapsedMs: Date.now() - startedAt,
        requestSucceeded: Boolean(result.ok),
        extractedCount: deals.length,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.pageSignal ? { pageSignal: result.pageSignal } : {}),
        products: deals.slice(0, 8).map(deal => ({
          title: deal.title,
          priceEGP: deal.price,
          oldPriceEGP: deal.old_price || null,
          discountPercent: deal.discount_pct || 0,
          url: deal.url
        }))
      };
      report.push(entry);
      console.log(JSON.stringify(entry, null, 2));
    }
  } finally {
    if (backupKey === undefined) delete process.env.SCRAPER_API_KEY_2;
    else process.env.SCRAPER_API_KEY_2 = backupKey;
  }

  const totals = report.reduce((sum, row) => sum + row.extractedCount, 0);
  console.log("\nLIVE DEAL SOURCES SUMMARY");
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    retailersTested: report.length,
    maximumRequests: report.length,
    totalValidatedProducts: totals,
    results: report.map(({ source, requestSucceeded, extractedCount, reason, pageSignal, elapsedMs }) =>
      ({ source, requestSucceeded, extractedCount, ...(reason ? { reason } : {}), ...(pageSignal ? { pageSignal } : {}), elapsedMs }))
  }, null, 2));
  if (report.some(row => !row.requestSucceeded)) process.exitCode = 1;
})().catch(error => {
  console.error("LIVE_TEST_FAILED:", String(error && error.message || error).replace(/api_key=[^&\s]+/gi, "api_key=[REDACTED]"));
  process.exitCode = 1;
});
