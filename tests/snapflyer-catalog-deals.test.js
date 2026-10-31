"use strict";

const assert = require("node:assert/strict");
const {
  parseEgpPrice, extractSnapFlyerCatalogDeals, collectSnapFlyerCatalogDeals
} = require("../modules/snapflyer-catalog-deals");

assert.equal(parseEgpPrice("194.95 ج.م"), 194.95);
assert.equal(parseEgpPrice("١١٤٫٩٥ جنيه"), null, "unsupported decimal separators must fail closed");
assert.equal(parseEgpPrice("7.80 جنيه / ١٠٠ مل"), 7.8);

const catalogUrl = "https://snapflyer.io/eg/downtown/offers/metro-market/1532";
const fixture = `
<button type="button" class="product-card sf-card-open">
  <div class="ptitle">جل غسالات اتوماتيك برسيل للملابس السوداء 2.5 لتر</div>
  <div class="price-row"><span class="price-now">194.95 ج.م</span><span class="price-was">239.95</span></div>
  <div class="price-unit">7.80 جنيه / ١٠٠ مل</div>
</button>
<button type="button" class="product-card sf-card-open">
  <div class="ptitle">منظف اطباق اوكسي 2.5 لتر</div>
  <div class="price-row"><span class="price-now">114.95 ج.م</span><span class="price-was">133.95</span></div>
</button>
<button type="button" class="product-card sf-card-open">
  <div class="ptitle">لحمة مفرومة طازجة 1 كجم</div>
  <div class="price-row"><span class="price-now">199.95 ج.م</span></div>
</button>
<button type="button" class="product-card sf-card-open">
  <div class="ptitle">مسحوق غسيل تجريبي</div>
  <div class="price-row"><span class="price-was">199.95</span></div>
</button>`;

const deals = extractSnapFlyerCatalogDeals(fixture, "metro_market", catalogUrl);
assert.equal(deals.length, 2);
assert.deepEqual(deals.map(item => item.price), [194.95, 114.95]);
assert.ok(deals.every(item => item.url === catalogUrl), "all newsletter links must target the catalog page");
assert.ok(deals.every(item => item.source === "snapflyer_catalog"));
assert.ok(!deals.some(item => /لحمة/.test(item.title)), "food products must be excluded");
assert.ok(!deals.some(item => /تجريبي/.test(item.title)), "cards without a current price must be excluded");

(async () => {
  const calls = [];
  const storeListings = {
    kazyon: '<a href="/eg/downtown/offers/kazyon/1711">Kazyon 29 - 31 Oct</a>',
    bim: '<a href="/eg/downtown/offers/bim/1648">BIM 29 - 31 Oct</a>',
    metro_market: '<a href="/eg/downtown/offers/metro-market/1532">Metro 22 Oct - 1 Nov</a>'
  };
  const pages = new Map([
    ["https://snapflyer.io/eg/downtown/offers/kazyon/1711", '<button class="product-card"><div class="ptitle">تايد جل غسالات أوتوماتيك 2.35 لتر</div><span class="price-now">174.95 ج.م</span></button>'],
    ["https://snapflyer.io/eg/downtown/offers/bim/1648", '<button class="product-card"><div class="ptitle">لحوم طازجة</div><span class="price-now">100.00 ج.م</span></button>'],
    [catalogUrl, fixture]
  ]);
  const fetchPage = async url => {
    calls.push(url);
    if (url.includes("/stores/")) {
      const key = url.includes("/stores/kazyon") ? "kazyon" : url.includes("/stores/bim") ? "bim" : "metro_market";
      return storeListings[key];
    }
    return pages.get(url) || "";
  };
  const result = await collectSnapFlyerCatalogDeals({ fetchPage, now: new Date("2026-10-31T12:00:00Z") });
  assert.equal(result.deals.length, 3);
  assert.ok(result.deals.some(item => item.title.includes("تايد") && item.price === 174.95));
  assert.ok(result.deals.some(item => item.title.includes("برسيل") && item.price === 194.95));
  assert.ok(!result.deals.some(item => item.title.includes("لحوم")));
  assert.equal(calls.length, 6, "fetch exactly three store listings and their three current catalogs");
  console.log("SnapFlyer catalog deal extraction tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
