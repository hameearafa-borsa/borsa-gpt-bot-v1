"use strict";

// Bounded live diagnostic. No Telegram, database, or publishing.
const dotenvPath = process.env.DOTENV_CONFIG_PATH;
require("dotenv").config(dotenvPath ? { path: dotenvPath } : undefined);
const { fetchSearch } = require("../modules/deal-sources");

const allSources = [
  { name: "jumia", query: "مسحوق غسيل منظف" },
  { name: "noon", query: "مسحوق غسيل منظف" },
  { name: "carrefour", query: "" }
];

(async () => {
  const credential = String(process.env.DEALS_LIVE_CREDENTIAL || "primary").trim().toLowerCase();
  const sourceFilter = String(process.env.DEALS_LIVE_SOURCE || "all").trim().toLowerCase();
  if (!["primary", "secondary"].includes(credential)) {
    console.error("BLOCKED: DEALS_LIVE_CREDENTIAL must be primary or secondary.");
    process.exitCode = 2;
    return;
  }
  const selectedKey = credential === "secondary"
    ? String(process.env.SCRAPER_API_KEY_2 || "").trim()
    : String(process.env.SCRAPER_API_KEY || "").trim();
  if (!selectedKey) {
    console.error(`BLOCKED: selected ${credential} ScraperAPI credential is not configured.`);
    process.exitCode = 2;
    return;
  }
  const sources = sourceFilter === "all" ? allSources : allSources.filter(source => source.name === sourceFilter);
  if (!sources.length) {
    console.error("BLOCKED: DEALS_LIVE_SOURCE must be jumia, noon, carrefour, or all.");
    process.exitCode = 2;
    return;
  }

  // Isolate the selected credential so each retailer causes exactly one request.
  const originalPrimary = process.env.SCRAPER_API_KEY;
  const originalSecondary = process.env.SCRAPER_API_KEY_2;
  process.env.SCRAPER_API_KEY = selectedKey;
  delete process.env.SCRAPER_API_KEY_2;
  const report = [];
  try {
    for (const source of sources) {
      const startedAt = Date.now();
      const result = await fetchSearch(source.name, source.query, { timeoutMs: 70000 });
      const deals = Array.isArray(result.deals) ? result.deals : [];
      const entry = {
        source: source.name,
        credentialTested: credential,
        query: source.query || "(retailer offers page)",
        elapsedMs: Date.now() - startedAt,
        requestSucceeded: Boolean(result.ok),
        extractedCount: deals.length,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.pageSignal ? { pageSignal: result.pageSignal } : {}),
        ...(result.extractionDiagnostics ? { extractionDiagnostics: result.extractionDiagnostics } : {}),
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
    if (originalPrimary === undefined) delete process.env.SCRAPER_API_KEY;
    else process.env.SCRAPER_API_KEY = originalPrimary;
    if (originalSecondary === undefined) delete process.env.SCRAPER_API_KEY_2;
    else process.env.SCRAPER_API_KEY_2 = originalSecondary;
  }

  const totals = report.reduce((sum, row) => sum + row.extractedCount, 0);
  console.log("\nLIVE DEAL SOURCES SUMMARY");
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    credentialTested: credential,
    retailersTested: report.length,
    maximumRequests: report.length,
    totalValidatedProducts: totals,
    results: report.map(({ source, requestSucceeded, extractedCount, reason, pageSignal, extractionDiagnostics, elapsedMs }) =>
      ({ source, requestSucceeded, extractedCount, ...(reason ? { reason } : {}), ...(pageSignal ? { pageSignal } : {}), ...(extractionDiagnostics ? { extractionDiagnostics } : {}), elapsedMs }))
  }, null, 2));
  if (report.some(row => !row.requestSucceeded)) process.exitCode = 1;
})().catch(error => {
  console.error("LIVE_TEST_FAILED:", String(error && error.message || error).replace(/api_key=[^&\\s]+/gi, "api_key=[REDACTED]"));
  process.exitCode = 1;
});
