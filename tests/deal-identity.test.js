"use strict";
const assert = require("node:assert/strict");
const { dealFingerprint, dealProductFingerprint, validateDeal, isRecentDuplicate } = require("../modules/deals");
const { filterRecentDeals } = require("../modules/deal-publication");
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
  console.log("deal identity + exact-observation weekly duplicate tests: OK");
(error => { console.error(error); process.exit(1); });
