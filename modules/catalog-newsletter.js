"use strict";

const crypto = require("node:crypto");

const CATALOG_REGION = "محافظة القاهرة";
const CATALOG_STORES = Object.freeze({
  kazyon: { name: "كازيون", region: CATALOG_REGION, url: "https://snapflyer.io/eg/downtown/stores/kazyon" },
  bim: { name: "BIM", region: CATALOG_REGION, url: "https://snapflyer.io/eg/downtown/stores/bim" },
  metro_market: { name: "مترو ماركت", region: CATALOG_REGION, url: "https://snapflyer.io/eg/downtown/stores/metro-market?lang=en" }
});

const RELEVANT_CATEGORIES = Object.freeze([
  "detergent", "paper", "personal_care"
]);

const RELEVANT_TERMS = /detergent|cleaning|home|personal care|paper|tissue|wipes|shampoo|soap|laundry|dishwash|منظف|تنظيف|مسحوق|غسيل|مناديل|ورقي|شامبو|صابون|عناية|كلور|مطهر|حفاض/i;

function normalizeText(value) {
  return String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\s+/g, " ").trim();
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeCatalogUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "snapflyer.io" ||
        url.username || url.password || (url.port && url.port !== "443")) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Extracts store flyer links from a SnapFlyer store listing page.
 * It deliberately records flyer title/date metadata only; product selection
 * must come from extracted offer records, not assumptions based on flyer title.
 */
function extractCatalogs(html, storeKey) {
  const store = CATALOG_STORES[storeKey];
  if (!store || typeof html !== "string") return [];
  const results = [];
  const anchors = [...html.matchAll(/<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)];
  for (const match of anchors) {
    const href = safeCatalogUrl(new URL(match[2], store.url).href);
    if (!href || !/\/offers\//i.test(new URL(href).pathname)) continue;
    const title = normalizeText(match[4]);
    if (!title || title.length < 5) continue;
    const context = normalizeText(match[1] + " " + match[3] + " " + match[4]);
    const dateMatch = context.match(/(\d{1,2}\s+[A-Za-z]{3}\s*(?:-|–)\s*\d{1,2}\s+[A-Za-z]{3}|\d{1,2}\s*[-–]\s*\d{1,2}\s+[A-Za-z]{3})/i);
    results.push({
      store: storeKey,
      storeName: store.name,
      region: store.region,
      title: title.slice(0, 180),
      url: href,
      displayedDateRange: dateMatch ? dateMatch[1] : null,
      fingerprint: stableHash(storeKey + "|" + href + "|" + title)
    });
  }
  const unique = new Map();
  for (const item of results) if (!unique.has(item.url)) unique.set(item.url, item);
  return [...unique.values()];
}

function isRelevantOffer(offer) {
  const title = String(offer?.title || "");
  const category = String(offer?.category || "").toLowerCase();
  return RELEVANT_CATEGORIES.includes(category) || RELEVANT_TERMS.test(title);
}

function changedCatalogs(previousFingerprints, currentCatalogs) {
  const previous = new Set(previousFingerprints || []);
  return (currentCatalogs || []).filter(c => c && c.fingerprint && !previous.has(c.fingerprint));
}

module.exports = {
  CATALOG_REGION,
  CATALOG_STORES,
  RELEVANT_CATEGORIES,
  normalizeText,
  stableHash,
  safeCatalogUrl,
  extractCatalogs,
  isRelevantOffer,
  changedCatalogs
};
