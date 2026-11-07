"use strict";

const { fetchStorePage } = require("./catalog-newsletter-scheduler");
const { plainText, parseEgpPrice } = require("./snapflyer-catalog-deals");
const { isRelevantOffer } = require("./catalog-newsletter");
const { validateDeal } = require("./deals");

const FILTERS = Object.freeze([
  { key: "laundry-detergent", category: "cleaning", type: "laundry-detergent" },
  { key: "surface-cleaners", category: "cleaning", type: "surface-cleaners" },
  { key: "dishwashing", category: "cleaning", type: "dishwashing" },
  { key: "fabric-softener", category: "cleaning", type: "fabric-softener" },
  { key: "bleach", category: "cleaning", type: "bleach" },
  { key: "air-fresheners", category: "cleaning", type: "air-fresheners" },
  { key: "tissues-paper", category: "cleaning", type: "tissues-paper" },
  { key: "insecticides", category: "cleaning", type: "insecticides" },
  { key: "personal-care", category: "personal-care", type: null }
]);

const MERCHANT_ALIASES = Object.freeze([
  { canonical: "Abdullah Al Othaim Markets Egypt", aliases: ["Abdullah Al Othaim Markets Egypt", "العثيم"] },
  { canonical: "El Fergany Hyper Market", aliases: ["El Fergany Hyper Market", "الفرجاني"] },
  { canonical: "Metro Market", aliases: ["Metro Market", "مترو ماركت", "مترو"] },
  { canonical: "Panda Market Egypt", aliases: ["Panda Market Egypt", "Panda Market", "باندا"] },
  { canonical: "LuLu Hypermarket Egypt", aliases: ["LuLu Hypermarket Egypt", "LuLu Hypermarket", "لولو"] },
  { canonical: "Beit El Gomla", aliases: ["Beit El Gomla", "بيت الجملة"] },
  { canonical: "Awlad Ragab", aliases: ["Awlad Ragab", "أولاد رجب", "اولاد رجب"] },
  { canonical: "Kheir Zaman", aliases: ["Kheir Zaman", "خير زمان"] },
  { canonical: "Hyper One", aliases: ["Hyper One", "هايبر وان"] },
  { canonical: "Fathallah", aliases: ["Fathallah", "فتح الله"] },
  { canonical: "Spinneys", aliases: ["Spinneys", "سبينيس"] },
  { canonical: "Carrefour", aliases: ["Carrefour", "كارفور"] },
  { canonical: "Kazyon", aliases: ["Kazyon", "كازيون"] },
  { canonical: "BIM", aliases: ["BIM", "بيم"] },
  { canonical: "Seoudi Market", aliases: ["Seoudi Market", "السعودي"] },
  { canonical: "Raneen", aliases: ["Raneen", "رنين"] },
  { canonical: "El Hawary", aliases: ["El Hawary", "الهواري"] }
].flatMap(item => item.aliases.map(alias => ({ canonical: item.canonical, alias })))
  .sort((a, b) => b.alias.length - a.alias.length));
const TRACKED_CATALOG_MERCHANTS = Object.freeze([
  { key: "metro_market", name: "Metro Market" },
  { key: "kazyon", name: "Kazyon" },
  { key: "bim", name: "BIM" }
]);

const PRICE_RE = /(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:EGP\b|جنيه|ج\s*\.?\s*م\.?)/i;
const DISCOUNT_RE = /-\s*(\d{1,2}(?:\.\d+)?)\s*%/;
const EXCLUDE_RE = /\b(?:tv|laptop|mobile|phone|appliance|coffee maker|furniture|fashion|shoes|toys|electronics)\b|تلفزيون|موبايل|لابتوب|أجهزة كهربائية|أثاث|ملابس|أحذية|ألعاب/i;
const RELEVANT_PRODUCT_RE = /detergent|powder|laundry|washing|dishwash|cleaner|cleaning|disinfectant|bleach|softener|air freshener|insecticide|tissue|paper towel|toilet paper|wipes|shampoo|soap|hand wash|body wash|deodorant|toothpaste|shaving|sanitary pad|منظف|تنظيف|مسحوق|بودر|غسيل|غسالات|أطباق|اطباق|صحون|منعم|كلور|مطهر|مبيض|مناديل|ورق تواليت|شامبو|صابون|عناية|مزيل عرق|معطر جو|مبيد حشري|فوط صحية|معجون أسنان/i;

function productUrl(raw, baseUrl) {
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== "https:" || url.hostname !== "snapflyer.io" ||
        url.username || url.password || (url.port && url.port !== "443")) return null;
    if (!(/^\/product\/\d+\/?$/i.test(url.pathname) ||
          /^\/eg\/[a-z0-9-]+\/products\/\d+\/?$/i.test(url.pathname))) return null;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return null; }
}

function categoryOf(title) {
  const text = String(title || "").toLowerCase();
  if (/مناديل|ورق تواليت|فاين|كلينكس|tissue|toilet paper|paper towel|wipes/.test(text)) return "paper";
  if (/شامبو|صابون|شاور|غسول|كريم|مزيل عرق|معجون أسنان|شفرات|فوط صحية|shampoo|soap|hand wash|hand soap|body wash|deodorant|toothpaste|razor|shaving|sanitary pad/.test(text)) return "personal_care";
  return "detergent";
}

function parseMerchantAndTitle(rawText) {
  let text = String(rawText || "").replace(/^Snap\s*Flyer\s*/i, "").trim();
  let merchant = null;
  for (const item of MERCHANT_ALIASES) {
    if (!text.toLocaleLowerCase("en").startsWith(item.alias.toLocaleLowerCase("en"))) continue;
    const remainder = text.slice(item.alias.length);
    if (remainder && !/^[\s|•·—–-]/.test(remainder)) continue;
    merchant = item.canonical;
    text = remainder.replace(/^[\s|•·—–-]+/, "").trim();
    break;
  }
  return { merchant, title: text };
}

function extractOfferFromAnchor(anchorHtml, rawHref, filterKey, baseUrl) {
  const url = productUrl(rawHref, baseUrl);
  if (!url) return null;
  const text = plainText(anchorHtml);
  const priceMatch = PRICE_RE.exec(text);
  if (!priceMatch) return null;
  const price = parseEgpPrice(priceMatch[0]);
  if (!(price > 0)) return null;

  const prefix = text.slice(0, priceMatch.index).replace(/^Snap\s*Flyer\s*/i, "").trim();
  const { merchant, title: merchantlessPrefix } = parseMerchantAndTitle(prefix);
  const title = (merchantlessPrefix || prefix).replace(/^[|•·—–-]+|[|•·—–-]+$/g, "").trim();
  if (title.length < 3 || EXCLUDE_RE.test(title) || (!RELEVANT_PRODUCT_RE.test(title) && !isRelevantOffer({ title }))) return null;

  const afterPrice = text.slice(priceMatch.index + priceMatch[0].length);
  const discountMatch = afterPrice.match(DISCOUNT_RE);
  const discount = discountMatch ? Number(discountMatch[1]) : 0;
  const oldPriceMatch = afterPrice.match(/^\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)(?=\s*(?:-\s*\d+(?:\.\d+)?\s*%|$))/);
  const oldPrice = oldPriceMatch ? Number(oldPriceMatch[1].replace(/,/g, "")) : null;

  const deal = {
    merchant,
    title: title.slice(0, 180),
    url,
    price,
    old_price: oldPrice && oldPrice > price ? oldPrice : null,
    discount_pct: discount,
    category: categoryOf(title),
    source: "snapflyer_filtered_offers",
    source_filter: filterKey
  };
  return validateDeal(deal).ok ? deal : null;
}

function extractSnapFlyerFilteredOffers(html, filter, baseUrl) {
  if (typeof html !== "string" || !filter || !baseUrl) return [];
  const found = [];
  const anchorPattern = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const href = match[2];
    if (!/\/product\/\d+\/?(?:[?#]|$)|\/products\/\d+\/?(?:[?#]|$)/i.test(href)) continue;
    const deal = extractOfferFromAnchor(match[4], href, filter.key, baseUrl);
    if (deal) found.push(deal);
  }
  return [...new Map(found.map(deal => [deal.url + "|" + deal.price, deal])).values()];
}

function filterUrl(filter) {
  const url = new URL("https://snapflyer.io/eg/downtown/products");
  url.searchParams.set("category", filter.category);
  url.searchParams.set("lang", "en");
  if (filter.type) url.searchParams.set("type", filter.type);
  return url.href;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index]); }
      catch (error) { results[index] = { error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function collectSnapFlyerFilteredOffers({ fetchPage = fetchStorePage, filters = FILTERS, concurrency = 3 } = {}) {
  const results = await mapWithConcurrency(filters, concurrency, async filter => {
    const url = filterUrl(filter);
    const html = await fetchPage(url);
    const deals = extractSnapFlyerFilteredOffers(html, filter, url);
    return { filter, deals };
  });
  const deals = [];
  const errors = [];
  const sourceStats = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const filter = filters[i];
    if (result?.error) {
      errors.push({ source: "snapflyer_filter_" + filter.key, reason: String(result.error.message || "fetch_failed").slice(0, 120) });
      sourceStats.push({ source: "snapflyer_filter_" + filter.key, ok: false, stage: "transport", extractedCount: 0 });
      continue;
    }
    deals.push(...result.deals);
    sourceStats.push({
      source: "snapflyer_filter_" + filter.key,
      ok: true,
      stage: result.deals.length ? "validated" : "no_relevant_product_cards",
      extractedCount: result.deals.length
    });
  }
  const unique = [...new Map(deals.map(deal => [deal.url + "|" + deal.title + "|" + deal.price, deal])).values()];
  const storeStats = TRACKED_CATALOG_MERCHANTS.map(store => {
    const extractedCount = unique.filter(deal => deal.merchant === store.name).length;
    return {
      source: "snapflyer_store_" + store.key,
      merchant: store.name,
      ok: true,
      stage: extractedCount ? "validated" : "no_store_offers",
      extractedCount
    };
  });
  const missingMerchantCount = unique.filter(deal => !deal.merchant).length;
  return { deals: unique, errors, sourceStats: [...sourceStats, ...storeStats], storeStats, missingMerchantCount, sourceCount: filters.length };
}

module.exports = {
  FILTERS, filterUrl, productUrl, categoryOf, parseMerchantAndTitle,
  extractOfferFromAnchor, extractSnapFlyerFilteredOffers, collectSnapFlyerFilteredOffers
};
