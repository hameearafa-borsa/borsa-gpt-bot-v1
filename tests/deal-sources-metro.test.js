"use strict";
const assert = require("node:assert/strict");
const { safeProductUrl, fetchSearch, collectDealCandidates, extractCards, categoryOf } = require("../modules/deal-sources");
const { verifyProductUrl, newsletterKindAt, selectNewsletterDeals, publishDailyDeals } = require("../modules/deal-scheduler");

const fixture = `<html><body><div class="product-card card" data-id="123"><a href="/product/Persil-Automatic-Powder-3kg/123"><h5>Persil Automatic Powder 3kg</h5></a><div class="price"><p class="after">175.00 LE</p><p class="before">210.00 LE</p></div></div></body></html>`;
assert.equal(safeProductUrl("/product/Persil-Automatic-Powder-3kg/123?utm_source=test", "metro"), "https://shop.metro-markets.com/product/Persil-Automatic-Powder-3kg/123");
assert.equal(safeProductUrl("https://evil.example/product/Persil-Automatic-Powder-3kg/123", "metro"), null);
assert.equal(safeProductUrl("http://shop.metro-markets.com/product/Persil-Automatic-Powder-3kg/123", "metro"), null);
assert.equal(categoryOf("Fine Touch 2Ply Kitchen Towel"), "paper");
const groceryFixture = `<div class="product-card"><a href="/product/Al-Doha-Fine-Flour/6565"><h5>Al Doha Fine Flour - 1Kg</h5></a><div class="price"><p class="after">32.99 LE</p></div></div>`;
assert.equal(extractCards(groceryFixture, "metro").length, 0, "food products must not leak into detergent/paper/personal-care offers");

const beforeKey1 = process.env.SCRAPER_API_KEY;
const beforeKey2 = process.env.SCRAPER_API_KEY_2;
delete process.env.SCRAPER_API_KEY;
delete process.env.SCRAPER_API_KEY_2;

(async () => {
  let directUrl = null;
  const direct = await fetchSearch("metro", "ignored search", {
    fetchImpl: async (url, options) => {
      directUrl = String(url);
      assert.equal(options.redirect, "follow");
      assert.match(options.headers["accept-language"], /ar-EG/);
      return { ok: true, status: 200, url: "https://shop.metro-markets.com/promotions", text: async () => fixture };
    }
  });
  assert.equal(directUrl, "https://shop.metro-markets.com/promotions");
  assert.equal(direct.ok, true, "Metro must fetch directly without ScraperAPI credentials");
  assert.equal(direct.deals.length, 1);
  assert.equal(direct.deals[0].merchant, "مترو ماركت");
  assert.equal(direct.deals[0].title, "Persil Automatic Powder 3kg");
  assert.equal(direct.deals[0].price, 175);
  assert.equal(direct.deals[0].old_price, 210);
  assert.equal(direct.deals[0].url, "https://shop.metro-markets.com/product/Persil-Automatic-Powder-3kg/123");

  let snapFlyerCalls = 0;
  const collected = await collectDealCandidates({
    edition: "metro_stores",
    fetchImpl: async (url, options) => {
      assert.equal(String(url), "https://shop.metro-markets.com/promotions");
      assert.equal(options.redirect, "follow");
      return { ok: true, status: 200, url: "https://shop.metro-markets.com/promotions", text: async () => fixture };
    },
    snapFlyerFetcher: async () => { snapFlyerCalls++; throw new Error("Metro edition must not call SnapFlyer"); }
  });
  assert.equal(collected.sourceCount, 1);
  assert.equal(collected.deals.length, 1);
  assert.equal(collected.deals[0].merchant, "مترو ماركت");
  assert.equal(snapFlyerCalls, 0);

  assert.equal(newsletterKindAt(new Date("2026-11-11T09:29:00.000Z")), null, "Metro window begins at 11:30 Cairo");
  assert.equal(newsletterKindAt(new Date("2026-11-11T09:30:00.000Z")), "metro_stores");
  assert.equal(newsletterKindAt(new Date("2026-11-11T09:59:00.000Z")), "metro_stores");
  assert.equal(newsletterKindAt(new Date("2026-11-11T10:00:00.000Z")), null);
  assert.equal(newsletterKindAt(new Date("2026-11-11T10:30:00.000Z")), "online_stores");
  assert.equal(newsletterKindAt(new Date("2026-11-11T12:00:00.000Z")), "market_stores");
  // Egypt returned to UTC+2 after daylight-saving time ended on 2026-10-30.
  // Assert every newsletter window against the actual Cairo offset on 2026-11-12.
  const postDstSchedule = [
    ["2026-11-12T09:29:00.000Z", null],
    ["2026-11-12T09:30:00.000Z", "metro_stores"],
    ["2026-11-12T09:59:00.000Z", "metro_stores"],
    ["2026-11-12T10:00:00.000Z", null],
    ["2026-11-12T10:30:00.000Z", "online_stores"],
    ["2026-11-12T11:29:00.000Z", "online_stores"],
    ["2026-11-12T11:30:00.000Z", null],
    ["2026-11-12T12:00:00.000Z", "market_stores"],
    ["2026-11-12T12:59:00.000Z", "market_stores"],
    ["2026-11-12T13:00:00.000Z", null],
    ["2026-11-12T14:00:00.000Z", "amazon"],
    ["2026-11-12T14:44:00.000Z", "amazon"],
    ["2026-11-12T14:45:00.000Z", null]
  ];
  for (const [timestamp, expected] of postDstSchedule) {
    assert.equal(newsletterKindAt(new Date(timestamp)), expected, "wrong Cairo newsletter window at " + timestamp);
  }

  const selected = selectNewsletterDeals([
    { merchant: "مترو ماركت", title: "مسحوق برسيل 3 كيلو", category: "detergent", price: 175, url: "https://shop.metro-markets.com/product/Persil-Automatic-Powder-3kg/123" },
    { merchant: "Noon Egypt", title: "شامبو دوف", category: "personal_care", price: 100, url: "https://www.noon.com/egypt-ar/dove-123" },
    { merchant: "مترو ماركت", title: "مناديل فاين", category: "paper", price: 25, url: "https://shop.metro-markets.com/products/metro-456" }
  ], "metro_stores");
  assert.equal(selected.length, 2);
  assert.ok(selected.every(deal => new URL(deal.url).hostname === "shop.metro-markets.com"));

  const verified = await verifyProductUrl("https://shop.metro-markets.com/product/Persil-Automatic-Powder-3kg/123", {
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "HEAD");
      return { status: 200, headers: { get: () => null } };
    }
  });
  assert.equal(verified.ok, true, "official Metro product links must pass the URL verifier");

  const queries = [], messages = [];
  const pool = { query: async (sql, values = []) => {
    const normalized = String(sql).replace(/\\s+/g, " ").trim();
    queries.push({ sql: normalized, values });
    if (normalized.includes("FROM service_settings")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("SELECT channel_kind,status,chat_id FROM deal_publications")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("SELECT 1 FROM deal_observations")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("INSERT INTO deal_publications")) return { rows: [{ id: 9001 }], rowCount: 1 };
    if (normalized.startsWith("UPDATE deal_publications")) return { rows: [], rowCount: 1 };
    if (normalized.startsWith("INSERT INTO deal_observations")) return { rows: [], rowCount: 1 };
    throw new Error("Unexpected Metro publication SQL: " + normalized);
  } };
  let requestedEdition = null;
  const publication = await publishDailyDeals({
    pool,
    telegram: { sendMessage: async (chatId, message) => { messages.push({ chatId, message }); return { message_id: 9901 }; } },
    chatIds: [-1001234567890],
    now: new Date("2026-11-11T09:30:00.000Z"),
    fetcher: async ({ edition }) => {
      requestedEdition = edition;
      return { deals: [
        { merchant: "مترو ماركت", title: "Persil Automatic Powder 3kg", price: 175, old_price: 210, category: "detergent", url: "https://shop.metro-markets.com/product/Persil-Automatic-Powder-3kg/123" },
        { merchant: "مترو ماركت", title: "مناديل فاين ورقية 200 منديل", price: 25, category: "paper", url: "https://shop.metro-markets.com/products/metro-456" }
      ], errors: [], sourceStats: [], sourceCount: 1 };
    },
    verify: async deals => deals.map(deal => ({ ...deal, verified_url: true }))
  });
  assert.equal(requestedEdition, "metro_stores");
  assert.equal(publication.kind, "metro_stores");
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /عروض مترو ماركت/);
  assert.match(messages[0].message, /مترو ماركت/);
  assert.ok(!messages[0].message.includes("SnapFlyer"));
  assert.ok(queries.some(item => item.sql.startsWith("INSERT INTO deal_publications")));
  assert.equal(publication.published[0].count, 2);

  if (beforeKey1 === undefined) delete process.env.SCRAPER_API_KEY; else process.env.SCRAPER_API_KEY = beforeKey1;
  if (beforeKey2 === undefined) delete process.env.SCRAPER_API_KEY_2; else process.env.SCRAPER_API_KEY_2 = beforeKey2;
  console.log("Metro direct extraction + isolated newsletter scheduling/publication tests: OK");
})().catch(error => {
  if (beforeKey1 === undefined) delete process.env.SCRAPER_API_KEY; else process.env.SCRAPER_API_KEY = beforeKey1;
  if (beforeKey2 === undefined) delete process.env.SCRAPER_API_KEY_2; else process.env.SCRAPER_API_KEY_2 = beforeKey2;
  console.error(error);
  process.exit(1);
});
