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

const MERCHANT_NAMES = Object.freeze([
  "Abdullah Al Othaim Markets Egypt", "El Fergany Hyper Market", "Metro Market",
  "Panda Market Egypt", "LuLu Hypermarket Egypt", "Beit El Gomla",
  "Awlad Ragab", "Kheir Zaman", "Hyper One", "Fathallah", "Spinneys",
  "Carrefour", "Kazyon", "BIM", "Seoudi Market", "Raneen", "El Hawary",
  "أسواق عبدالله العثيم", "عبدالله العثيم", "العثيم مصر", "العثيم", "الفرجاني ماركت", "الفرجاني",
  "مترو ماركت", "مترو", "باندا", "اللولو", "بيت الجملة", "أولاد رجب",
  "خير زمان", "هايبر وان", "فتح الله", "سبينيس", "كارفور", "كازيون",
  "بيم", "سبينس", "سعودي ماركت", "سعودي", "رنين", "الهواري"
].sort((a, b) => b.length - a.length));

function normalizeDisplayedDigits(value) {
  return String(value || "")
    .replace(/[٠-٩۰-۹]/g, digit => String("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹".indexOf(digit) % 10))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",");
}

const PRICE_RE = /(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:EGP\b|جنيه|ج\s*\.?\s*م\.?)/i;
const DISCOUNT_RE = /-\s*(\d{1,2}(?:\.\d+)?)\s*%/;
const EXCLUDE_RE = /\b(?:tv|laptop|mobile|phone|appliance|coffee maker|furniture|fashion|shoes|toys|electronics)\b|تلفزيون|موبايل|لابتوب|أجهزة كهربائية|أثاث|ملابس|أحذية|ألعاب/i;
const RELEVANT_PRODUCT_RE = /detergent|powder|laundry|washing|dishwash|cleaner|cleaning|disinfectant|bleach|softener|air freshener|insecticide|tissue|paper towel|toilet paper|wipes|shampoo|soap|hand wash|body wash|deodorant|toothpaste|shaving|sanitary pad|حلاقة|حلاقه|منظف|تنظيف|مسحوق|بودر|غسيل|غسالات|أطباق|اطباق|صحون|منعم|كلور|مطهر|مبيض|مناديل|ورق تواليت|شامبو|صابون|عناية|مزيل عرق|معطر جو|مبيد حشري|فوط صحية|معجون أسنان/i;

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
  if (/شامبو|صابون|شاور|غسول|كريم|مزيل عرق|معجون أسنان|شفرات|حلاقة|حلاقه|فوم حلاقة|فوم حلاقه|فوط صحية|active man|shampoo|soap|hand wash|hand soap|body wash|deodorant|toothpaste|razor|shaving|sanitary pad/.test(text)) return "personal_care";
  return "detergent";
}

function parseMerchantAndTitle(rawText) {
  let text = String(rawText || "").replace(/^(?:Snap\s*Flyer|سناب\s*فلاير)\s*/i, "").trim();
  let merchant = null;
  for (const name of MERCHANT_NAMES) {
    if (text.toLocaleLowerCase("en").startsWith(name.toLocaleLowerCase("en"))) {
      merchant = name;
      text = text.slice(name.length).trim();
      break;
    }
  }
  return { merchant, title: text };
}

function extractOfferFromAnchor(anchorHtml, rawHref, filterKey, baseUrl) {
  const url = productUrl(rawHref, baseUrl);
  if (!url) return null;
  const displayedText = plainText(anchorHtml);
  const text = normalizeDisplayedDigits(displayedText);
  const priceMatch = PRICE_RE.exec(text);
  if (!priceMatch) return null;
  const price = parseEgpPrice(priceMatch[0]);
  if (!(price > 0)) return null;

  const prefix = text.slice(0, priceMatch.index).replace(/^(?:Snap\s*Flyer|سناب\s*فلاير)\s*/i, "").trim();
  const { merchant, title: merchantlessPrefix } = parseMerchantAndTitle(prefix);
  const title = (merchantlessPrefix || prefix).replace(/^[|•·—–-]+|[|•·—–-]+$/g, "").trim();
  if (title.length < 3 || EXCLUDE_RE.test(title) || (!RELEVANT_PRODUCT_RE.test(title) && !isRelevantOffer({ title }))) return null;

  const afterPrice = text.slice(priceMatch.index + priceMatch[0].length);
  const discountMatch = afterPrice.match(/-\s*(\d{1,2}(?:\.\d+)?)\s*(?:%|٪)/);
  const discount = discountMatch ? Number(discountMatch[1]) : 0;
  const oldPriceMatch = afterPrice.match(/^\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)(?=\s*(?:-\s*\d+(?:\.\d+)?\s*(?:%|٪)|$))/);
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
  return { deals: unique, errors, sourceStats, sourceCount: filters.length };
}

module.exports = {
  FILTERS, filterUrl, productUrl, categoryOf, parseMerchantAndTitle, normalizeDisplayedDigits,
  extractOfferFromAnchor, extractSnapFlyerFilteredOffers, collectSnapFlyerFilteredOffers
};
