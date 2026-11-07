"use strict";
const assert = require("node:assert/strict");
const { dealFingerprint, dealProductFingerprint, validateDeal, isRecentDuplicate } = require("../modules/deals");
const { filterRecentDeals, formatNewsletterMessage } = require("../modules/deal-publication");
const { persistDeals } = require("../modules/deal-scheduler");
const base = { merchant: "Amazon", title: "مسحوق بيرل 2 كجم", url: "https://www.amazon.eg/dp/B012345678", price: 100, old_price: 120, discount_pct: 17, category: "detergent" };
assert.equal(validateDeal(base).ok, true);
assert.notEqual(dealFingerprint(base), dealFingerprint({ ...base, price: 95 }), "price observation fingerprint changes with price");
assert.equal(dealProductFingerprint(base), dealProductFingerprint({ ...base, price: 95, old_price: 110, discount_pct: 14 }), "same retailer product remains same product across price changes");
assert.notEqual(dealProductFingerprint(base), dealProductFingerprint({ ...base, url: "https://www.amazon.eg/dp/B012345679" }), "different retailer product IDs must remain distinct");
assert.notEqual(dealProductFingerprint(base), dealProductFingerprint({ ...base, title: "مسحوق بيرل 5 كجم", url: "https://www.amazon.eg/dp/B012345679" }), "different pack sizes must remain distinct");
(async () => {
  let args;
  const pool = { query: async (_sql, values) => { args = values; return { rowCount: 1, rows: [{}] }; } };
  assert.equal(await isRecentDuplicate(pool, "deal-fp", 7, "product-fp"), true);
  assert.deepEqual(args, ["deal-fp", 7], "weekly suppression checks the exact offer fingerprint only");

  const changedPrice = { ...base, price: 90, old_price: 120, discount_pct: 25 };
  const giftBundle = { ...base, title: "مسحوق بيرل 2 كجم مع هدية", price: 100 };
  const existingFingerprint = dealFingerprint(base);
  const fakePool = {
    query: async (_sql, values) => ({
      rowCount: values[0] === existingFingerprint ? 1 : 0,
      rows: values[0] === existingFingerprint ? [{}] : []
    })
  };
  const deals = await filterRecentDeals(fakePool, [base, changedPrice, giftBundle], 7);
  assert.equal(deals.length, 2, "a changed price and a gift bundle remain publishable even when the base product was recently observed");
  assert.ok(deals.some(d => d.price === 90), "changed-price offer should remain");
  assert.ok(deals.some(d => d.title.includes("هدية")), "gift bundle should remain distinct");

  // Historical observed price is distinct from a retailer-advertised list price.
  let persistedSql = "";
  let persistedParams = [];
  const historyPool = { query: async (sql, params) => { persistedSql = sql; persistedParams = params; return { rowCount: 1 }; } };
  assert.equal(await persistDeals(historyPool, [{ ...base, price: 90, old_price: null, discount_pct: 0 }]), 1);
  assert.ok(persistedSql.includes("previous_observed_price,price_change_pct"), "history must be stored in dedicated columns");
  assert.ok(persistedSql.includes("product_fingerprint=$9 AND price<>$5"), "previous price must belong to the same product and be a different price");
  assert.ok(persistedSql.includes("ORDER BY observed_at DESC,id DESC LIMIT 1"), "use the most recent earlier different-price observation");
  assert.deepEqual(persistedParams.slice(0, 7), ["Amazon", base.title, base.url, "detergent", 90, null, 0]);
  assert.ok(persistedSql.includes("old_price=EXCLUDED.old_price"), "retailer list price remains independent");

  const historyMessage = formatNewsletterMessage([{
    ...base, price: 449, old_price: null, previous_observed_price: 499, price_change_pct: -10.02
  }], "اختبار تاريخ السعر");
  assert.ok(historyMessage.text.includes("📉 أقل من آخر رصد: 499.00 جنيه (10.02%)"),
    "newsletter must label a historical decrease as last observed price, not as a retailer discount");
  assert.ok(!historyMessage.text.includes("قبل الخصم:"), "historical price changes must not masquerade as a retailer discount");

  const increaseMessage = formatNewsletterMessage([{
    ...base, price: 499, old_price: null, previous_observed_price: 449, price_change_pct: 11.14
  }], "اختبار ارتفاع السعر");
  assert.ok(increaseMessage.text.includes("📈 أعلى من آخر رصد: 449.00 جنيه (11.14%)"),
    "historical increases must be shown with the correct direction");
  console.log("deal identity + historical observed price tests: OK");
})().catch(error => { console.error(error); process.exit(1); });
