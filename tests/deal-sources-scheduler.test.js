"use strict";
const assert = require("node:assert/strict");
const { safeProductUrl, categoryOf, extractCards, extractionDiagnostics, createExtractionCounters, fetchSearch, collectDealCandidates, getScraperKeys } = require("../modules/deal-sources");
const { verifyProductUrl, verifyDeals, batchKey, newsletterKindAt, isNewsletterWindow, selectNewsletterDeals, cairoParts, shouldBackoffAfterDealAttempt, shouldResetDealBackoff } = require("../modules/deal-scheduler");
const { formatNewsletterMessage } = require("../modules/deal-publication");
assert.equal(safeProductUrl("/dp/B0ABCDEF12?tag=tracking", "amazon"), "https://www.amazon.eg/dp/B0ABCDEF12");
assert.equal(safeProductUrl("https://evil.example/product", "amazon"), null);
assert.equal(safeProductUrl("http://www.amazon.eg/dp/B0ABCDEF12", "amazon"), null);
assert.equal(safeProductUrl("", "amazon"), null);
assert.equal(safeProductUrl("https://www.amazon.eg:8443/dp/B0ABCDEF12", "amazon"), null);
assert.equal(safeProductUrl("https://www.amazon.eg/", "amazon"), null);
assert.equal(categoryOf("مناديل فاين"), "paper");
assert.equal(categoryOf("شامبو نيفيا"), "personal_care");
assert.equal(categoryOf("مسحوق غسيل"), "detergent");
assert.equal(shouldBackoffAfterDealAttempt({ skipped: true, reason: "no_deals" }), true);
assert.equal(shouldBackoffAfterDealAttempt({ skipped: true, reason: "all_recent_or_invalid" }), true,
  "recent duplicate-only results should not trigger another paid scrape every minute");
assert.equal(shouldBackoffAfterDealAttempt({ skipped: true, reason: "message_too_long" }), true,
  "unpublishable formatting results should be throttled");
assert.equal(shouldBackoffAfterDealAttempt({ skipped: true, reason: "already_published" }), false);
assert.equal(shouldBackoffAfterDealAttempt({ published: [{ chatId: -100123 }] }), false);
assert.equal(shouldResetDealBackoff("amazon", "other_sites"), true,
  "a failed Amazon attempt must not suppress the 6 PM other-store edition");
assert.equal(shouldResetDealBackoff("other_sites", "amazon"), true,
  "a failed 6 PM attempt must not suppress the next Amazon edition");
assert.equal(shouldResetDealBackoff("amazon", "amazon"), false);
assert.equal(shouldResetDealBackoff("amazon", null), false,
  "outside the newsletter windows there is no active edition to reset to");
const html = `<article class="prd"><a href="/paper-product"><h3 class="name">مناديل فاين ورقية</h3></a><div class="prc">25.00 ج</div><div class="old">35.00 ج</div></article>`;
const cards = extractCards(html,"jumia");
assert.equal(cards.length,1);
assert.equal(cards[0].category,"paper");
assert.equal(cards[0].price,25);
assert.equal(cards[0].old_price,35);

const jumiaDivFixture = `<div class="prd product-card"><a href="/cleaning/bright-detergent.html"><h3 class="name">مسحوق برسيل للغسيل 2 كيلو</h3></a><span class="priceNow">149.00 ج.م</span><span class="oldPrice">189.00 ج.م</span></div>`;
const jumiaDivCards = extractCards(jumiaDivFixture, "jumia");
assert.equal(jumiaDivCards.length, 1, "Jumia product cards rendered as divs should be extracted");
assert.equal(jumiaDivCards[0].price, 149);
assert.equal(jumiaDivCards[0].old_price, 189);

const noonDivFixture = `<div data-testid="product-card"><a href="/egypt-ar/product/NOON123"><h3 class="product-title">شامبو دوف للعناية بالشعر</h3></a><span class="price-now">119.50 ج.م</span></div>`;
const noonDivCards = extractCards(noonDivFixture, "noon");
assert.equal(noonDivCards.length, 1, "Noon product cards rendered as divs should be extracted");
assert.equal(noonDivCards[0].price, 119.5);

const noonHydrationFixture = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { products: [
    { name: "مسحوق برسيل للغسالات 3 كيلو", slug: "/egypt-ar/product/PERSIL123", price: { value: "175.00", currency: "EGP" }, oldPrice: 210 }
  ] } }
})}</script>`;
const noonHydrationCards = extractCards(noonHydrationFixture, "noon");
assert.equal(noonHydrationCards.length, 1, "product data in JSON hydration state should be extracted without evaluating scripts");
assert.equal(noonHydrationCards[0].price, 175);
assert.equal(noonHydrationCards[0].old_price, 210);
const hydrationDiagnostics = extractionDiagnostics(noonHydrationFixture, "noon", noonHydrationCards);
assert.equal(hydrationDiagnostics.structuredScriptsFound, 1);
assert.equal(hydrationDiagnostics.structuredJsonParsed, 1);
assert.equal(hydrationDiagnostics.structuredProductObjects, 0,
  "hydration payloads without schema.org Product types should not be misreported as typed Product objects");
assert.deepEqual(hydrationDiagnostics.productObjectShapes, [],
  "product field-shape diagnostics should only describe typed Product objects");
assert.equal(hydrationDiagnostics.validatedDeals, 1);
const typedShapeFixture = `<script type="application/ld+json">${JSON.stringify({
  "@type": "Product", name: "مسحوق غسيل برسيل", url: "https://www.jumia.com.eg/persil-product",
  offers: { price: "120", priceCurrency: "EGP" }
})}</script>`;
const typedShapeDiagnostics = extractionDiagnostics(typedShapeFixture, "jumia");
assert.equal(typedShapeDiagnostics.productObjectShapes.length, 1);
assert.equal(typedShapeDiagnostics.productObjectShapes[0].fields.name, "string");
assert.equal(typedShapeDiagnostics.productObjectShapes[0].nested.offers.price, "string",
  "shape diagnostics must expose field names and types without exposing product values");


const jsonRejectFixture = product => `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", ...product })}</script>`;
const jsonCounters = createExtractionCounters();
const jsonDiagnosticFixture = [
  jsonRejectFixture({ name: "هاتف ذكي", url: "https://www.jumia.com.eg/phone", offers: { price: "100", priceCurrency: "EGP" } }),
  jsonRejectFixture({ name: "مسحوق برسيل للغسيل", url: "https://evil.example/item", offers: { price: "100", priceCurrency: "EGP" } }),
  jsonRejectFixture({ name: "منظف أرضيات", url: "https://www.jumia.com.eg/cleaner", offers: { price: "120", priceCurrency: "USD" } }),
  jsonRejectFixture({ name: "مناديل فاين ورقية", url: "https://www.jumia.com.eg/tissues", offers: { price: "35", priceCurrency: "EGP" } })
].join("");
const jsonDiagnosticDeals = extractCards(jsonDiagnosticFixture, "jumia", "", jsonCounters);
assert.equal(jsonDiagnosticDeals.length, 1);
assert.equal(jsonCounters.json.candidates, 4);
assert.equal(jsonCounters.json.rejectedName, 1);
assert.equal(jsonCounters.json.rejectedUrl, 1);
assert.equal(jsonCounters.json.rejectedCurrency, 1);
assert.equal(jsonCounters.json.accepted, 1);
assert.equal(JSON.stringify(jsonCounters).includes("مسحوق"), false, "diagnostics must not expose product values");
const htmlDiagnosticFixture = `
<div class="product-card"><a href="/valid-cleaner"><h3 class="product-title">منظف أرضيات متعدد الاستخدامات</h3></a><span class="currentPrice">55 ج.م</span></div>
<div class="product-card"><a href="https://evil.example/item"><h3 class="product-title">مسحوق برسيل للغسيل</h3></a><span class="currentPrice">100 ج.م</span></div>
<div class="product-card"><a href="/missing-price"><h3 class="product-title">مناديل فاين ورقية</h3></a></div>
<div class="product-card"><a href="/irrelevant"><h3 class="product-title">هاتف ذكي حديث</h3></a><span class="currentPrice">900 ج.م</span></div>`;
const htmlCounters = createExtractionCounters();
const htmlDiagnosticDeals = extractCards(htmlDiagnosticFixture, "carrefour", "", htmlCounters);
assert.equal(htmlDiagnosticDeals.length, 1);
assert.equal(htmlCounters.html.candidates, 4);
assert.equal(htmlCounters.html.rejectedName, 1);
assert.equal(htmlCounters.html.rejectedUrl, 1);
assert.equal(htmlCounters.html.rejectedPrice, 1);
assert.equal(htmlCounters.html.accepted, 1);

const carrefourFixture = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"فلفيتا جل منظف للملابس السوداء - 1 كيلو","url":"https://www.carrefouregypt.com/mafegy/ar/p/velvet-gel","offers":{"@type":"Offer","price":"79.99","priceCurrency":"EGP"}}</script>`;
const amazonStructuredFixture = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"اريال مسحوق غسيل 2 كيلو","url":"https://www.amazon.eg/dp/B0ABCDEF12","offers":{"@type":"Offer","price":"99.50","priceCurrency":"EGP"}}</script>`;
const amazonStructuredCards = extractCards(amazonStructuredFixture, "amazon", "اريال");
assert.equal(amazonStructuredCards.length, 1, "Amazon JSON-LD should be parsed when retailer HTML selectors change");
assert.equal(amazonStructuredCards[0].price, 99.5);
const amazonCardHtml = `<div data-component-type="s-search-result" data-asin="B0ABCDEF16"><div><h2><a href="/dp/B0ABCDEF16"><span>اريال مسحوق غسيل 2 كيلو</span></a></h2><div class="a-price"><span class="a-price-whole">129</span></div></div><div><span>تفاصيل إضافية</span></div></div><div data-component-type="s-search-result" data-asin="B0ABCDEF17"><h2><a href="/dp/B0ABCDEF17"><span>مناديل فاين ورقية</span></a></h2><span class="a-offscreen">45.00 جنيه</span></div>`;
const amazonCardDeals = extractCards(amazonCardHtml, "amazon", "منظفات");
assert.equal(amazonCardDeals.length, 2, "Amazon nested result cards should survive varying nesting depth");
assert.equal(amazonCardDeals[0].price, 129);
assert.equal(amazonCardDeals[1].price, 45);
assert.ok(amazonCardDeals.every(deal => deal.url.startsWith("https://www.amazon.eg/dp/")));

const noonStructuredFixture = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"شامبو نيفيا للعناية بالشعر","url":"https://www.noon.com/egypt-ar/product/N1234567","offers":{"@type":"Offer","price":"145","priceCurrency":"EGP"}}</script>`;
const noonStructuredCards = extractCards(noonStructuredFixture, "noon", "نيفيا");
assert.equal(noonStructuredCards.length, 1, "Noon JSON-LD should be parsed when retailer HTML selectors change");
assert.equal(noonStructuredCards[0].merchant, "Noon Egypt");
assert.equal(noonStructuredCards[0].price, 145);

const carrefourCards = extractCards(carrefourFixture, "carrefour");
assert.equal(carrefourCards.length, 1, "Carrefour Product JSON-LD should produce a validated deal");
assert.equal(carrefourCards[0].merchant, "Carrefour Egypt");
assert.equal(carrefourCards[0].price, 79.99);
assert.equal(carrefourCards[0].category, "detergent");

const carrefourCardFixture = `<div class="product-card"><a href="/mafegy/ar/p/velvet-cleaner"><h3 class="product-title">فلفيتا جل منظف للملابس السوداء 1 كيلو</h3></a><span class="currentPrice">79.99 ج.م</span></div>`;
const carrefourCardDeals = extractCards(carrefourCardFixture, "carrefour");
assert.equal(carrefourCardDeals.length, 1, "Carrefour product cards outside JSON-LD should also be eligible");
assert.equal(carrefourCardDeals[0].merchant, "Carrefour Egypt");
assert.equal(carrefourCardDeals[0].price, 79.99);
assert.equal(safeProductUrl("https://evil.example/mafegy/ar/p/velvet-gel", "carrefour"), null);
assert.equal(extractCards(carrefourFixture.replace('"price":"79.99"', '"price":"0"'), "carrefour").length, 0, "invalid prices must be rejected");

const irrelevantProductFixtures = [
  { source: "amazon", title: "شاشة تلفزيون ذكية مع كريم", url: "https://www.amazon.eg/dp/B0ABCDEF14" },
  { source: "jumia", title: "فستان نسائي كريم اللون", url: "https://www.jumia.com.eg/product-dress" },
  { source: "noon", title: "كريم طبخ 500 مل", url: "https://www.noon.com/egypt-ar/product/COOK123" },
  { source: "carrefour", title: "شامبو سيارات لتنظيف الهيكل", url: "https://www.carrefouregypt.com/mafegy/ar/p/car-shampoo" }
];
for (const item of irrelevantProductFixtures) {
  const fixture = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: item.title,
    url: item.url,
    offers: { "@type": "Offer", price: "99", priceCurrency: "EGP" }
  })}</script>`;
  assert.equal(extractCards(fixture, item.source).length, 0,
    `out-of-domain product must be excluded: ${item.title}`);
}
const relevantPersonalCareFixture = `<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Product",
  name: "كريم مرطب نيفيا للعناية بالبشرة",
  url: "https://www.amazon.eg/dp/B0ABCDEF15",
  offers: { "@type": "Offer", price: "99", priceCurrency: "EGP" }
})}</script>`;
assert.equal(extractCards(relevantPersonalCareFixture, "amazon").length, 1,
  "relevant personal-care products must remain eligible after tightening exclusions");

const expandedHouseholdFixture = `<script type="application/ld+json">${JSON.stringify({
  "@type": "Product",
  name: "منظف أرضيات متعدد الاستخدامات",
  url: "https://www.jumia.com.eg/cleaner-floor-product",
  offers: { price: "65", priceCurrency: "EGP" }
})}</script>`;
assert.equal(extractCards(expandedHouseholdFixture, "jumia").length, 1,
  "relevant household cleaning products should not be rejected by a narrow keyword allowlist");
const newsletterFixture = [
  { title: "منظف أول", merchant: "متجر", price: 25, url: "https://www.amazon.eg/dp/B0ABCDEF12" },
  { title: "رابط طويل", merchant: "متجر", price: 35, url: "https://www.amazon.eg/" + "x".repeat(500) }
];
const formattedNewsletter = formatNewsletterMessage(newsletterFixture, "اختبار النشرة", 300);
assert.equal(formattedNewsletter.items.length, 1, "only complete product blocks fitting the limit should be selected");
assert.ok(formattedNewsletter.text.length <= 300, "newsletter must remain under the Telegram message limit");
assert.ok(formattedNewsletter.text.includes(newsletterFixture[0].url), "included product URLs must remain intact");
assert.ok(!formattedNewsletter.text.includes("x".repeat(100)), "an oversized URL must not be partially published");
const sampleDate = new Date("2026-10-12T15:00:00.000Z");
assert.equal(batchKey(sampleDate),"2026-10-12");
assert.equal(isNewsletterWindow(new Date("2026-10-12T13:59:00.000Z")),false);
assert.equal(isNewsletterWindow(new Date("2026-10-12T14:00:00.000Z")),true);
assert.equal(newsletterKindAt(new Date("2026-10-12T14:00:00.000Z")),"amazon"); // 5 PM Cairo
assert.equal(newsletterKindAt(new Date("2026-10-12T15:00:00.000Z")),"other_sites"); // 6 PM Cairo
assert.equal(newsletterKindAt(new Date("2026-10-12T15:04:00.000Z")),"other_sites", "allow brief startup/timer jitter after 6 PM");
assert.equal(newsletterKindAt(new Date("2026-10-12T15:05:00.000Z")),null, "close the scheduled window after five minutes");
assert.equal(newsletterKindAt(new Date("2026-10-12T15:45:00.000Z")),null, "a late boot must not publish the 6 PM newsletter at 6:45 PM");
assert.equal(newsletterKindAt(new Date("2026-10-12T14:05:00.000Z")),null, "close the Amazon window after five minutes");
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
 const notModified = await verifyProductUrl("https://www.amazon.eg/dp/B0ABCDEF12", {fetchImpl:async()=>({status:304})});
 assert.equal(notModified.ok,false, "an unhandled 304 response must not count as a verified product URL");
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
 const malformedRedirect = await verifyProductUrl("https://www.amazon.eg/dp/B0ABCDEF12", {
   fetchImpl: async () => ({ status: 302, headers: { get: () => "http://[" } })
 });
 assert.equal(malformedRedirect.ok, false, "malformed redirect targets must be rejected");
 assert.equal(malformedRedirect.reason, "redirect_host_not_allowed");

 const badPort = await verifyProductUrl("https://www.amazon.eg:8443/dp/B0ABCDEF12");
 assert.equal(badPort.ok, false, "non-standard HTTPS ports must be rejected");

 const candidates = [
   { merchant: "Amazon.eg", title: "مسحوق غسيل مع هدية", url: "https://www.amazon.eg/dp/B0ABCDEF12", price: 100, category: "detergent" },
   { merchant: "Amazon.eg", title: "مناديل ورقية", url: "https://www.amazon.eg/dp/B0ABCDEF13", price: 30, category: "paper" }
 ];
 const retainedOnBlock = await verifyDeals(candidates, {
   fetchImpl: async () => ({ status: 403, headers: { get: () => null } })
 });
 assert.equal(retainedOnBlock.length, 2, "anti-bot 403 checks must not silently drop otherwise allowlisted offers");
 assert.ok(retainedOnBlock.every(d => d.verified_url === false));
 const retainedOnTimeout = await verifyDeals(candidates, {
   fetchImpl: async () => { const e = new Error("timed out"); e.name = "AbortError"; throw e; }
 });
 assert.equal(retainedOnTimeout.length, 2, "temporary verification timeouts must not silently drop offers");
 const removedUnsafeRedirect = await verifyDeals(candidates.slice(0, 1), {
   fetchImpl: async () => ({ status: 302, headers: { get: () => "https://evil.example/redirect" } })
 });
 assert.equal(removedUnsafeRedirect.length, 0, "unsafe redirects must still be rejected");

 const oldKey1 = process.env.SCRAPER_API_KEY;
 const oldKey2 = process.env.SCRAPER_API_KEY_2;
 process.env.SCRAPER_API_KEY = "test-account-one";
 process.env.SCRAPER_API_KEY_2 = "test-account-two";
 assert.deepEqual(getScraperKeys(), ["test-account-one", "test-account-two"]);
 const usedKeys = [];
 const fakeScraperFetch = async url => {
   usedKeys.push(new URL(String(url)).searchParams.get("api_key"));
   return { ok: true, status: 200, text: async () => "<html></html>" };
 };
 await fetchSearch("amazon", "test one", { fetchImpl: fakeScraperFetch });
 await fetchSearch("amazon", "test two", { fetchImpl: fakeScraperFetch });
 assert.deepEqual(usedKeys, ["test-account-one", "test-account-two"], "independent scraper keys should rotate between requests");
 const authRetryKeys = [];
 const authRetry = await fetchSearch("amazon", "auth retry", {
   fetchImpl: async url => {
     authRetryKeys.push(new URL(String(url)).searchParams.get("api_key"));
     return authRetryKeys.length === 1
       ? { ok: false, status: 403, text: async () => "" }
       : { ok: true, status: 200, text: async () => "<html></html>" };
   }
 });
 assert.equal(authRetry.ok, true, "a credential rejection should retry once with the alternate key");
 assert.equal(authRetryKeys.length, 2, "credential retry must be bounded to one alternate request");
 assert.notEqual(authRetryKeys[0], authRetryKeys[1], "credential retry must use a different key");

 const serverRetryKeys = [];
 const serverRetry = await fetchSearch("noon", "temporary upstream error", {
   fetchImpl: async url => {
     serverRetryKeys.push(new URL(String(url)).searchParams.get("api_key"));
     return serverRetryKeys.length === 1
       ? { ok: false, status: 500, text: async () => "" }
       : { ok: true, status: 200, text: async () => noonHydrationFixture };
   }
 });
 assert.equal(serverRetry.ok, true, "a transient retailer/ScraperAPI 500 should receive one bounded alternate-key retry");
 assert.equal(serverRetry.deals.length, 1);
 assert.equal(serverRetryKeys.length, 2);
 assert.notEqual(serverRetryKeys[0], serverRetryKeys[1]);
 const noRetryKeys = [];
 const rateLimited = await fetchSearch("amazon", "no retry on rate limit", {
   fetchImpl: async url => {
     noRetryKeys.push(new URL(String(url)).searchParams.get("api_key"));
     return { ok: false, status: 429, text: async () => "" };
   }
 });
 assert.equal(rateLimited.ok, false);
 assert.equal(noRetryKeys.length, 1, "rate limits must not trigger a second potentially wasteful request");
 const timeoutKeys = [];
 const timeoutError = new Error("simulated timeout");
 timeoutError.name = "AbortError";
 const timedOut = await fetchSearch("amazon", "no retry on timeout", {
   fetchImpl: async url => {
     timeoutKeys.push(new URL(String(url)).searchParams.get("api_key"));
     throw timeoutError;
   }
 });
 assert.equal(timedOut.reason, "timeout");
 assert.equal(timeoutKeys.length, 1, "timeouts must not retry and increase scraper usage");
 let activeRequests = 0, peakRequests = 0, requestCount = 0;
 const concurrencyFetch = async () => {
   activeRequests++;
   requestCount++;
   peakRequests = Math.max(peakRequests, activeRequests);
   await new Promise(resolve => setTimeout(resolve, 5));
   activeRequests--;
   return { ok: true, status: 200, text: async () => "<html></html>" };
 };
 const collected = await collectDealCandidates({
   amazonQueries: ["a", "b", "c"],
   otherQueries: ["d", "e", "f"],
   fetchImpl: concurrencyFetch
 });
 assert.equal(requestCount, 10, "all source queries should still be attempted");
 assert.ok(peakRequests <= 2, "ScraperAPI requests must be bounded to two concurrent requests");
 assert.equal(collected.sourceCount, 10);
 assert.equal(collected.sourceStats.length, 10, "each source request should report a safe extraction summary");
 assert.equal(collected.sourceSummary.length, 4, "store summaries should aggregate counters by retailer");
 assert.ok(collected.sourceSummary.every(summary => summary.queries > 0 && summary.transportFailures === 0),
   "per-store query totals should include every successful request");
 const failedQuerySummary = await collectDealCandidates({
   edition: "amazon",
   amazonQueries: ["one failed request"],
   fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" })
 });
 assert.equal(failedQuerySummary.sourceSummary.length, 1);
 assert.equal(failedQuerySummary.sourceSummary[0].queries, 1,
   "per-store query totals must include failed transport attempts");
 assert.equal(failedQuerySummary.sourceSummary[0].transportFailures, 1,
   "transport failures must be counted separately from attempted queries");
 assert.ok(collected.sourceStats.every(stat => Number.isInteger(stat.queryIndex) && ["extraction_empty", "candidate_rejection", "validated"].includes(stat.stage)), "each query should expose a safe query index and parser stage");
 assert.ok(collected.sourceStats.every(stat => stat.ok && stat.extractedCount === 0 && stat.stage === "extraction_empty"),
   "successful HTTP responses with empty parser results must be distinguishable from request failures");
 assert.equal(collected.errors.length, 10, "empty extraction should be visible in diagnostics even when HTTP requests succeeded");
 const amazonTargets = [];
 
 const blockedPage = await fetchSearch("amazon", "diagnostic test", {
   fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html><title>Robot Check</title><body>Automated access</body></html>" })
 });
 assert.equal(blockedPage.ok, true);
 assert.equal(blockedPage.pageSignal, "captcha_or_block_page",
   "HTTP 200 challenge pages should be distinguished from ordinary empty search results");
const amazonOnly = await collectDealCandidates({
   edition: "amazon",
   fetchImpl: async url => {
     amazonTargets.push(new URL(String(url)).searchParams.get("url"));
     return { ok: true, status: 200, text: async () => "<html></html>" };
   }
 });
 assert.equal(amazonOnly.sourceCount, 3, "Amazon edition should make only three Amazon searches");
 assert.equal(amazonTargets.length, 3);
 assert.ok(amazonTargets.every(url => new URL(url).hostname.includes("amazon")),
   "Amazon edition must not spend scraper requests on other stores");

 const otherTargets = [];
 const otherOnly = await collectDealCandidates({
   edition: "other_sites",
   fetchImpl: async url => {
     otherTargets.push(new URL(String(url)).searchParams.get("url"));
     return { ok: true, status: 200, text: async () => "<html></html>" };
   }
 });
 assert.equal(otherOnly.sourceCount, 7, "other-store edition should make seven non-Amazon searches");
 assert.equal(otherTargets.length, 7);
 assert.ok(otherTargets.every(url => !new URL(url).hostname.includes("amazon")),
   "other-store edition must not spend scraper requests on Amazon");

 if (oldKey1 === undefined) delete process.env.SCRAPER_API_KEY; else process.env.SCRAPER_API_KEY = oldKey1;
 if (oldKey2 === undefined) delete process.env.SCRAPER_API_KEY_2; else process.env.SCRAPER_API_KEY_2 = oldKey2;
 console.log("deal sources + safe URL verification + Cairo scheduler + scraper key rotation/concurrency tests: OK");
})().catch(e=>{console.error(e);process.exit(1)});
