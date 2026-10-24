"use strict";
const assert = require("node:assert/strict");
const { safeProductUrl, categoryOf, extractCards } = require("../modules/deal-sources");
const { verifyProductUrl, batchKey, newsletterKindAt, isNewsletterWindow, selectNewsletterDeals, cairoParts } = require("../modules/deal-scheduler");
assert.equal(safeProductUrl("/dp/B0ABCDEF12?tag=tracking", "amazon"), "https://www.amazon.eg/dp/B0ABCDEF12");
assert.equal(safeProductUrl("https://evil.example/product", "amazon"), null);
assert.equal(safeProductUrl("http://www.amazon.eg/dp/B0ABCDEF12", "amazon"), null);
assert.equal(safeProductUrl("", "amazon"), null);
assert.equal(safeProductUrl("https://www.amazon.eg:8443/dp/B0ABCDEF12", "amazon"), null);
assert.equal(safeProductUrl("https://www.amazon.eg/", "amazon"), null);
assert.equal(categoryOf("مناديل فاين"), "paper");
assert.equal(categoryOf("شامبو نيفيا"), "personal_care");
assert.equal(categoryOf("مسحوق غسيل"), "detergent");
const html = `<article class="prd"><a href="/paper-product"><h3 class="name">مناديل فاين ورقية</h3></a><div class="prc">25.00 ج</div><div class="old">35.00 ج</div></article>`;
const cards = extractCards(html,"jumia");
assert.equal(cards.length,1);
assert.equal(cards[0].category,"paper");
assert.equal(cards[0].price,25);
assert.equal(cards[0].old_price,35);
const sampleDate = new Date("2026-10-12T15:00:00.000Z");
assert.equal(batchKey(sampleDate),"2026-10-12");
assert.equal(isNewsletterWindow(new Date("2026-10-12T13:59:00.000Z")),false);
assert.equal(isNewsletterWindow(new Date("2026-10-12T14:00:00.000Z")),true);
assert.equal(newsletterKindAt(new Date("2026-10-12T14:00:00.000Z")),"amazon"); // 5 PM Cairo
assert.equal(newsletterKindAt(new Date("2026-10-12T15:00:00.000Z")),"other_sites"); // 6 PM Cairo
assert.equal(newsletterKindAt(new Date("2026-10-12T16:00:00.000Z")),null); // no third newsletter
const makeDeals = (host, prefix) => ["detergent","paper","personal_care"].flatMap(category =>
  Array.from({length: 6}, (_,i) => ({
    merchant: prefix, title: `${prefix} ${category} product ${i}`,
    url: `https://${host}/product-${category}-${i}`, price: 10+i,
    old_price: 15+i, discount_pct: 20, category
  }))
);
const editionAmazon = selectNewsletterDeals([...makeDeals("www.amazon.eg","Amazon"), ...makeDeals("www.jumia.com.eg","Jumia")], "amazon");
const editionOther = selectNewsletterDeals([...makeDeals("www.amazon.eg","Amazon"), ...makeDeals("www.jumia.com.eg","Jumia")], "other_sites");
assert.equal(editionAmazon.length, 15, "Amazon edition caps at five items in each of three categories");
assert.ok(editionAmazon.every(d => new URL(d.url).hostname === "www.amazon.eg"));
assert.equal(editionOther.length, 15, "other-store edition balances independently, not crowded out by Amazon");
assert.ok(editionOther.every(d => new URL(d.url).hostname === "www.jumia.com.eg"));
for (const edition of [editionAmazon, editionOther]) {
  for (const category of ["detergent","paper","personal_care"]) {
    assert.ok(edition.filter(d => d.category === category).length <= 5);
  }
}

(async()=>{
 const ok = await verifyProductUrl("https://www.amazon.eg/dp/B0ABCDEF12", {fetchImpl:async url=>({status:200,url:String(url)})});
 assert.equal(ok.ok,true);
 const bad = await verifyProductUrl("https://evil.example/x", {fetchImpl:async()=>({status:200,url:"https://evil.example/x"})});
 assert.equal(bad.ok,false);
 let redirectCalls = 0;
 const redirected = await verifyProductUrl("https://www.amazon.eg/dp/B0ABCDEF12", {
   fetchImpl: async (_url, options) => {
     redirectCalls++;
     assert.equal(options.redirect, "manual", "redirects must be validated before following");
     return { status: 302, headers: { get: () => "https://evil.example/redirect-target" } };
   }
 });
 assert.equal(redirected.ok, false);
 assert.equal(redirected.reason, "redirect_host_not_allowed");
 assert.equal(redirectCalls, 1, "must not make a request to a disallowed redirect target");
 const badPort = await verifyProductUrl("https://www.amazon.eg:8443/dp/B0ABCDEF12");
 assert.equal(badPort.ok, false, "non-standard HTTPS ports must be rejected");
 console.log("deal sources + safe URL verification + Cairo scheduler tests: OK");
})().catch(e=>{console.error(e);process.exit(1)});
