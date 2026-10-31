"use strict";

const assert = require("node:assert/strict");
const { CATALOG_STORES, normalizeText, isRelevantOffer } = require("../modules/catalog-newsletter");
const { fetchStorePage } = require("../modules/catalog-newsletter-scheduler");

function decodeHtml(value) {
  return String(value || "").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&nbsp;|&#160;/gi, " ");
}

function extractLinkedProducts(html, storeKey, baseUrl) {
  const results = [];
  const pattern = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    let url;
    try { url = new URL(match[2], baseUrl); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname !== "snapflyer.io" ||
        !/^\/eg\/[a-z0-9-]+\/products\/\d+$/i.test(url.pathname)) continue;
    const title = normalizeText(decodeHtml(match[4]));
    if (!title || title.length < 3) continue;
    const end = (match.index || 0) + match[0].length;
    const trailing = normalizeText(decodeHtml(html.slice(end, end + 700).replace(/<a\b[\s\S]*$/i, " ")));
    const priceMatch = trailing.match(/(?:—|-|–)\s*(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:EGP|ج\s*\.?\s*م\.?|جنيه)/i);
    const candidate = { store: storeKey, title, url: url.href, priceHint: priceMatch ? priceMatch[1].replace(/,/g, "") : null };
    if (isRelevantOffer(candidate)) results.push(candidate);
  }
  const unique = new Map();
  for (const item of results) if (!unique.has(item.url)) unique.set(item.url, item);
  return [...unique.values()];
}

(async () => {
  console.log("Live SnapFlyer store-page product discovery diagnostic");
  let total = 0;
  for (const [storeKey, store] of Object.entries(CATALOG_STORES)) {
    const html = await fetchStorePage(store.url);
    const products = extractLinkedProducts(html, storeKey, store.url);
    total += products.length;
    console.log("\n=== " + store.name + " (" + storeKey + ") ===");
    console.log("Relevant individual product links discovered: " + products.length);
    for (const product of products.slice(0, 20)) {
      console.log(JSON.stringify(product));
    }
    if (!products.length) {
      console.log("No relevant product links are exposed in the configured store-page HTML.");
    }
  }
  console.log("\nLIVE PRODUCT DISCOVERY DIAGNOSTIC: OK (" + total + " relevant linked products exposed)");
})().catch(error => {
  console.error("LIVE PRODUCT DISCOVERY DIAGNOSTIC: FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
