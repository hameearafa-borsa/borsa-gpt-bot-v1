"use strict";

const {
  CATALOG_STORES, normalizeText, isRelevantOffer, extractCatalogs,
  selectOneCatalogPerStore
} = require("../modules/catalog-newsletter");
const { fetchStorePage } = require("../modules/catalog-newsletter-scheduler");

const PRICE_RE = /(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:EGP\b|جنيه|ج\s*\.?\s*م\.?)/i;

function decodeHtml(value) {
  return String(value || "").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&nbsp;|&#160;/gi, " ");
}

function plainText(html) {
  return normalizeText(decodeHtml(String(html || "")
    .replace(/<script\\b[\\s\\S]*?<\\/script>/gi, " ")
    .replace(/<style\\b[\\s\\S]*?<\\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")));
}

function catalogTextLines(html) {
  const text = decodeHtml(String(html || ""))
    .replace(/<script\\b[\\s\\S]*?<\\/script>/gi, " ")
    .replace(/<style\\b[\\s\\S]*?<\\/style>/gi, " ")
    .replace(/<(?:br|\\/p|\\/div|\\/li|\\/h[1-6]|\\/article|\\/section|\\/a|\\/span|\\/strong|\\/b)\\b[^>]*>/gi, "\\n")
    .replace(/<[^>]*>/g, " ");
  return text.split(/[\\r\\n]+/)
    .map(line => normalizeText(line))
    .filter(Boolean);
}

function normalizeDigits(value) {
  return String(value || "").replace(/[٠-٩۰-۹]/g, digit =>
    "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹".indexOf(digit) % 10
  );
}

function extractStoreProductLinks(html, storeKey, baseUrl) {
  const results = [];
  const pattern = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    let url;
    try { url = new URL(match[2], baseUrl); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname !== "snapflyer.io" ||
        !/^\/eg\/[a-z0-9-]+\/products\/\d+$/i.test(url.pathname)) continue;
    const title = plainText(match[4]);
    if (!title || title.length < 3) continue;
    const candidate = { store: storeKey, title, url: url.href };
    if (isRelevantOffer(candidate)) results.push(candidate);
  }
  return [...new Map(results.map(item => [item.url, item])).values()];
}

/**
 * SnapFlyer renders "Products on this page" as repeated image anchors followed
 * by ordinary HTML text nodes containing the product title and prices.
 * The image anchor is only a card boundary; the newsletter link intentionally
 * points to the catalog page, not to an individual product or snippet image.
 */
function extractCatalogProductRecords(html, storeKey, catalogUrl) {
  if (typeof html !== "string" || !catalogUrl) return [];
  const heading = /Products\\s+on\\s+this\\s+page/i.exec(plainText(html));
  if (!heading) return [];

  // Work from the visible text stream, not from assumptions about snippet-image
  // anchors. SnapFlyer exposes the offer title and price as ordinary page text.
  const visible = catalogTextLines(html);
  const headingIndex = visible.findIndex(line => /Products\\s+on\\s+this\\s+page/i.test(line));
  if (headingIndex < 0) return [];
  const section = [];
  for (const line of visible.slice(headingIndex + 1)) {
    if (/^(?:Same\\s+Product\\s+in\\s+Other\\s+Stores|Similar\\s+products)$/i.test(line)) break;
    if (/^No products extracted from this page yet\\.?$/i.test(line)) continue;
    section.push(line);
  }

  const products = [];
  for (let i = 0; i < section.length; i++) {
    const line = normalizeDigits(section[i]);
    const priceMatch = PRICE_RE.exec(line);
    if (!priceMatch) continue;

    // SnapFlyer places the current price first, followed by the old price and
    // discount. A unit-price line is not the offer price and is never selected.
    if (/\\/\\s*100\\s*(?:g|ml)|\\/\\s*pc\\b/i.test(line)) continue;
    let title = line.slice(0, priceMatch.index).trim();
    if (!title) {
      for (let j = i - 1; j >= 0; j--) {
        const previous = section[j];
        if (PRICE_RE.test(normalizeDigits(previous)) || /\\/\\s*100\\s*(?:g|ml)|\\/\\s*pc\\b/i.test(previous)) continue;
        title = previous.trim();
        break;
      }
    }
    title = title.replace(/^[|•·—–-]+|[|•·—–-]+$/g, "").trim();
    if (!title || title.length < 3) continue;

    const candidate = {
      store: storeKey,
      title,
      price: Number(priceMatch[1].replace(/,/g, "")),
      currency: "EGP",
      catalogUrl,
      sourceUrl: catalogUrl
    };
    if (!Number.isFinite(candidate.price) || candidate.price <= 0 || !isRelevantOffer(candidate)) continue;
    products.push(candidate);
  }

  return [...new Map(products.map(item => [item.title.toLocaleLowerCase("ar") + "|" + item.price, item])).values()];
}

(async () => {
  console.log("Live SnapFlyer catalog-page text product discovery diagnostic");
  let storePageLinks = 0;
  let catalogCandidates = 0;

  for (const [storeKey, store] of Object.entries(CATALOG_STORES)) {
    const storeHtml = await fetchStorePage(store.url);
    const storeLinks = extractStoreProductLinks(storeHtml, storeKey, store.url);
    storePageLinks += storeLinks.length;
    const editions = selectOneCatalogPerStore(extractCatalogs(storeHtml, storeKey), new Date());

    console.log("\n=== " + store.name + " (" + storeKey + ") ===");
    console.log("Store-page direct product links: " + storeLinks.length);
    console.log("Current catalog editions discovered: " + editions.length);
    for (const edition of editions) {
      console.log("Catalog: " + edition.title + " | " + edition.url);
      const catalogHtml = await fetchStorePage(edition.url);
      const products = extractCatalogProductRecords(catalogHtml, storeKey, edition.url);
      catalogCandidates += products.length;
      console.log("Relevant text product + price candidates: " + products.length);
      for (const product of products) {
        console.log(JSON.stringify({
          store: storeKey,
          title: product.title,
          price: product.price,
          currency: product.currency,
          hyperlink: product.catalogUrl
        }));
      }
    }
  }

  console.log("\nLIVE CATALOG PRODUCT DISCOVERY SUMMARY");
  console.log("Store-page direct product links: " + storePageLinks);
  console.log("Relevant text product + price candidates: " + catalogCandidates);
  console.log("Newsletter hyperlink target: catalog page URL");
  console.log("Discovery evidence only; candidates are NOT approved for publication.");
})().catch(error => {
  console.error("LIVE CATALOG PRODUCT DISCOVERY DIAGNOSTIC: FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});

module.exports = { extractCatalogProductRecords };
