"use strict";
const assert = require("node:assert/strict");
const {
  CATALOG_STORES, safeCatalogUrl, extractCatalogs, isRelevantOffer, changedCatalogs
} = require("../modules/catalog-newsletter");

assert.deepEqual(Object.keys(CATALOG_STORES).sort(), ["bim", "kazyon", "metro_market"]);
assert.equal(safeCatalogUrl("https://snapflyer.io/eg/downtown/offers/kazyon/1376"), "https://snapflyer.io/eg/downtown/offers/kazyon/1376");
assert.equal(safeCatalogUrl("https://evil.example/eg/downtown/offers/kazyon/1376"), null);
assert.equal(safeCatalogUrl("http://snapflyer.io/eg/downtown/offers/kazyon/1376"), null);
const html = `
<a href="/eg/downtown/offers/kazyon/1376"><span>Kazyon — Lowest Price Everyday</span></a>
<a href="https://evil.example/eg/downtown/offers/kazyon/1377">Bad link should not pass</a>
<a href="/eg/downtown/stores/kazyon">Store link should not pass</a>
`;
const catalogs = extractCatalogs(html, "kazyon");
assert.equal(catalogs.length, 1);
assert.equal(catalogs[0].store, "kazyon");
assert.equal(catalogs[0].url, "https://snapflyer.io/eg/downtown/offers/kazyon/1376");
assert.ok(catalogs[0].fingerprint);
assert.equal(extractCatalogs(html, "unknown").length, 0);
assert.equal(isRelevantOffer({ title: "Clorox laundry bleach", category: "groceries" }), true);
assert.equal(isRelevantOffer({ title: "Women's cotton dress", category: "fashion" }), false);
assert.equal(isRelevantOffer({ title: "Generic item", category: "personal_care" }), true);
const all = [{ fingerprint: "a" }, { fingerprint: "b" }, { fingerprint: "a" }];
assert.deepEqual(changedCatalogs(["a"], all).map(x => x.fingerprint), ["b"]);
console.log("catalog newsletter helper tests: OK");
