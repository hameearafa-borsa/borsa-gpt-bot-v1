"use strict";

const assert = require("node:assert/strict");
const {
  FILTERS, filterUrl, productUrl, extractSnapFlyerFilteredOffers, collectSnapFlyerFilteredOffers
} = require("../modules/snapflyer-filtered-offers");
const { verifyProductUrl } = require("../modules/deal-scheduler");

assert.equal(FILTERS.some(item => item.key === "laundry-detergent"), true);
assert.equal(
  filterUrl(FILTERS.find(item => item.key === "laundry-detergent")),
  "https://snapflyer.io/eg/downtown/products?category=cleaning&lang=en&type=laundry-detergent"
);
assert.equal(productUrl("https://snapflyer.io/product/236503", "https://snapflyer.io/eg/downtown/products"), "https://snapflyer.io/product/236503");
assert.equal(productUrl("https://evil.example/product/236503", "https://snapflyer.io/eg/downtown/products"), null);
assert.equal(productUrl("https://snapflyer.io/eg/downtown/stores/bim", "https://snapflyer.io/eg/downtown/products"), null);

const filter = FILTERS.find(item => item.key === "laundry-detergent");
const fixture = `
<a href="https://snapflyer.io/product/236503">SnapFlyer Spinneys Zeina Trio Compressed Toilet Tissue 6 Rolls 64.95 EGP 79.95 -19% 10.83 EGP / roll</a>
<a href="/eg/downtown/products/191711">SnapFlyer Kazyon Bahi Automatic Powder 8+1 Kg 488 EGP</a>
<a href="/eg/downtown/products/191712">SnapFlyer BIM Ariel Automatic Laundry Powder 9kg 514.95 EGP 599.95 -14%</a>
<a href="/eg/downtown/products/191713">SnapFlyer Carrefour Fresh Apples 1 Kg 39.95 EGP</a>
<a href="/eg/downtown/products/191714">SnapFlyer Spinneys Smart TV 43 inch 4,999 EGP</a>
<a href="/eg/downtown/products/191715">SnapFlyer Metro Market Persil Automatic Laundry Gel 3.9L</a>
<a href="/eg/downtown/products/191716">SnapFlyer UnknownStore Ariel Laundry Gel 2.5L 199.95 EGP 229.95 -13%</a>`;

const deals = extractSnapFlyerFilteredOffers(fixture, filter, "https://snapflyer.io/eg/downtown/products?category=cleaning&lang=en&type=laundry-detergent");
assert.equal(deals.length, 4, "only relevant product links with a current EGP price should be accepted");
assert.ok(deals.some(item => item.url === "https://snapflyer.io/product/236503" && item.price === 64.95 && item.old_price === 79.95));
assert.ok(deals.some(item => item.title.includes("Bahi") && item.merchant === "Kazyon"));
assert.ok(deals.some(item => item.title.includes("Ariel") && item.merchant === "BIM"));
assert.ok(deals.some(item => item.title.includes("Ariel") && item.merchant === null), "missing merchant must not reject a valid offer");
assert.ok(!deals.some(item => /Apples|Smart TV|Persil/.test(item.title)));

(async () => {
  const calls = [];
  const result = await collectSnapFlyerFilteredOffers({
    filters: FILTERS.slice(0, 2),
    fetchPage: async url => {
      calls.push(url);
      return url.includes("laundry-detergent") ? fixture : "";
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(result.sourceCount, 2);
  assert.equal(result.deals.length, 4);
  assert.equal(result.sourceStats.filter(item => item.ok).length, 2);

  const verified = await verifyProductUrl("https://snapflyer.io/product/236503", {
    fetchImpl: async url => ({ status: 200, url: String(url) })
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.finalUrl, "https://snapflyer.io/product/236503");

  let canonicalRedirectCalls = 0;
  const canonicalized = await verifyProductUrl("https://snapflyer.io/product/236503", {
    fetchImpl: async () => {
      canonicalRedirectCalls += 1;
      if (canonicalRedirectCalls === 1) {
        return { status: 302, headers: { get: () => "https://snapflyer.io/eg/downtown/products/236503" } };
      }
      return { status: 200 };
    }
  });
  assert.equal(canonicalized.ok, true, "same-product canonical redirects should remain valid");
  assert.equal(canonicalized.finalUrl, "https://snapflyer.io/eg/downtown/products/236503");

  const redirected = await verifyProductUrl("https://snapflyer.io/product/236503", {
    fetchImpl: async () => ({ status: 302, headers: { get: () => "https://snapflyer.io/product/999999" } })
  });
  assert.equal(redirected.ok, false);
  assert.equal(redirected.reason, "snapflyer_catalog_redirect_changed");

  console.log("SnapFlyer filtered product-offer tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
