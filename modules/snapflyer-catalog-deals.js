"use strict";

const {
  CATALOG_STORES, extractCatalogs, selectOneCatalogPerStore, isRelevantOffer, normalizeText
} = require("./catalog-newsletter");
const { validateDeal } = require("./deals");
const { fetchStorePage } = require("./catalog-newsletter-scheduler");

const PRICE_CLASS_RE = /<span\b[^>]*class=["'][^"']*\bprice-now\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i;
const TITLE_CLASS_RE = /<div\b[^>]*class=["'][^"']*\bptitle\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
const OLD_PRICE_CLASS_RE = /<span\b[^>]*class=["'][^"']*\bprice-was\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i;
const CARD_RE = /<button\b(?=[^>]*\bclass=["'][^"']*\bproduct-card\b)[^>]*>([\s\S]*?)<\/button>/gi;

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&nbsp;|&#160;/gi, " ");
}

function plainText(value) {
  return normalizeText(decodeEntities(String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")));
}

function asciiDigits(value) {
  return String(value || "").replace(/[٠-٩۰-۹]/g, digit => {
    const index = "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹".indexOf(digit);
    return String(index % 10);
  });
}

function parseEgpPrice(value) {
  const text = asciiDigits(plainText(value)).replace(/,/g, "");
  // Do not truncate malformed Arabic-decimal prices (e.g. ١١٤٫٩٥) to 114.
  if (/\d\s*[٫٬]\s*\d/.test(text)) return null;
  if (!/(?:EGP\b|جنيه|ج\s*\.?\s*م\.?)/i.test(text)) return null;
  const match = text.match(/(?:^|[^\d])(\d{1,6}(?:\.\d{1,2})?)(?=$|[^\d])/);
  if (!match) return null;
  const price = Number(match[1]);
  return Number.isFinite(price) && price > 0 && price <= 200000 ? price : null;
}

function categoryOf(title) {
  const text = String(title || "").toLowerCase();
  if (/حفاض|بامبرز|مولفكس|مناديل|فاين|محارم|كلينكس|ورقي/.test(text)) return "paper";
  if (/صابون|شامبو|كريم|غسول|مرطب|دوف|لوكس|بانتين|عناية|مكياج|تجميل|لوشن|سيروم|مزيل عرق|فازلين|نيفيا/.test(text)) return "personal_care";
  return "detergent";
}

function extractSnapFlyerCatalogDeals(html, storeKey, catalogUrl) {
  if (typeof html !== "string" || !CATALOG_STORES[storeKey] || !catalogUrl) return [];
  const deals = [];
  for (const match of html.matchAll(CARD_RE)) {
    const card = match[1];
    const title = plainText(card.match(TITLE_CLASS_RE)?.[1] || "");
    const price = parseEgpPrice(card.match(PRICE_CLASS_RE)?.[1] || "");
    if (title.length < 4 || price === null || !isRelevantOffer({ title })) continue;
    const oldPrice = parseEgpPrice(card.match(OLD_PRICE_CLASS_RE)?.[1] || "");
    const deal = {
      merchant: CATALOG_STORES[storeKey].name,
      title: title.slice(0, 180),
      // The newsletter intentionally links to the catalog page, never to a
      // product detail page or an individual snippet image.
      url: catalogUrl,
      price,
      old_price: oldPrice > price ? oldPrice : null,
      discount_pct: oldPrice > price ? Math.round((oldPrice - price) / oldPrice * 10000) / 100 : 0,
      category: categoryOf(title),
      source: "snapflyer_catalog"
    };
    if (validateDeal(deal).ok) deals.push(deal);
  }
  return [...new Map(deals.map(deal => [deal.title.toLocaleLowerCase("ar") + "|" + deal.price, deal])).values()];
}

async function collectSnapFlyerCatalogDeals({ fetchPage = fetchStorePage, now = new Date() } = {}) {
  const deals = [];
  const errors = [];
  const sourceStats = [];
  for (const [storeKey, store] of Object.entries(CATALOG_STORES)) {
    try {
      const listingHtml = await fetchPage(store.url);
      const catalogs = selectOneCatalogPerStore(extractCatalogs(listingHtml, storeKey), now);
      if (!catalogs.length) {
        sourceStats.push({ source: "snapflyer_" + storeKey, ok: true, stage: "no_current_catalog", extractedCount: 0 });
        continue;
      }
      const catalog = catalogs[0];
      const html = await fetchPage(catalog.url);
      const found = extractSnapFlyerCatalogDeals(html, storeKey, catalog.url);
      deals.push(...found);
      sourceStats.push({
        source: "snapflyer_" + storeKey,
        ok: true,
        stage: found.length ? "validated" : "catalog_page_without_eligible_text_cards",
        extractedCount: found.length
      });
    } catch (error) {
      errors.push({ source: "snapflyer_" + storeKey, reason: String(error?.message || "fetch_failed").slice(0, 120) });
      sourceStats.push({ source: "snapflyer_" + storeKey, ok: false, stage: "transport", extractedCount: 0, reason: "fetch_failed" });
    }
  }
  const unique = [...new Map(deals.map(deal => [deal.url + "|" + deal.title + "|" + deal.price, deal])).values()];
  return { deals: unique, errors, sourceStats, sourceCount: Object.keys(CATALOG_STORES).length };
}

module.exports = { decodeEntities, plainText, parseEgpPrice, extractSnapFlyerCatalogDeals, collectSnapFlyerCatalogDeals };
