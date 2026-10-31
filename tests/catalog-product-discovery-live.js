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
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")));
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
  const heading = /Products\s+on\s+this\s+page/i.exec(html);
  if (!heading) return [];
  let section = html.slice(heading.index + heading[0].length);
  const stop = /Same\s+Product\s+in\s+Other\s+Stores|Similar\s+products|<footer\b/i.exec(section);
  if (stop) section = section.slice(0, stop.index);

  const anchors = [...section.matchAll(/<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)];
  const products = [];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const anchorHtml = anchor[0];
    // Product cards begin with a linked image. Ignore navigation and text links.
    if (!/<img\b/i.test(anchorHtml)) continue;
    const href = decodeHtml(anchor[2]);
    if (!/\/storage\/flyers\/[^"'?#]+\/snippets\/snippet_[a-z0-9]+\.(?:webp|png|jpe?g)(?:[?#]|$)/i.test(href)) continue;

    const start = anchor.index + anchor[0].length;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : section.length;
    const cardText = plainText(section.slice(start, end));
    const priceMatch = PRICE_RE.exec(cardText);
    if (!priceMatch) continue;

    // Keep only the product title before the first current price. Old prices,
    // discount percentages and unit-price text are deliberately not treated as offers.
    const title = cardText.slice(0, priceMatch.index).replace(/[\s|•·—–-]+$/g, "").trim();
    if (!title) continue;
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
