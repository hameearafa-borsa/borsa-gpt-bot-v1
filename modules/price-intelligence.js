"use strict";

const crypto = require("node:crypto");
const { normalizeArabic, toAsciiDigits, parseNumber, parseQuantity } = require("../core/normalization");

const RETAIL_WORDS = /(?:مستهلك|قطاعي|تجزئ|بيع|للمستهلك|رف|تجزئة)/i;
const WHOLESALE_WORDS = /(?:جمله|جملة|كرتونه|كرتونة|فاتوره|فاتورة|تاجر|جمله|سعر الاساس|السعر الاساسى)/i;
const PACK_RE = /(?:\*|×)\s*(\d+)\s*(?:ق|قط|قطعه|قطعة|كيس|جوال|شكاره|شكارة)?|(?:^|\s)x\s*(\d+)\s*(?=(?:ق|قط|قطعه|قطعة|كيس|جوال|شكاره|شكارة|$))/i;
const PACK_ANY_RE = /(?:^|\s)(\d+)\s*(?:ق|قط|قطعه|قطعة|كيس|جوال|شكاره|شكارة)(?=\s|$)/i;
const EXTRA_RE = /(?:\+|زائد|زياده|زيادة)\s*(\d+(?:[.,]\d+)?)\s*(كيلو|كجم|ك|جرام|جم|g|kg)/i;

function classifyPriceKind(text) {
  const s = normalizeArabic(text);
  if (RETAIL_WORDS.test(s) && !WHOLESALE_WORDS.test(s)) return "retail";
  if (WHOLESALE_WORDS.test(s)) return "wholesale";
  return "unknown";
}

function parsePackCount(text) {
  const s = toAsciiDigits(text);
  const m = s.match(PACK_RE) || s.match(PACK_ANY_RE);
  if (!m) return null;
  const n = m[1] ?? m[2];
  return n ? Number(n) : null;
}

function parseExtraWeight(text) {
  const m = toAsciiDigits(String(text || "")).match(EXTRA_RE);
  if (!m) return null;
  const q = parseQuantity(`${m[1]} ${m[2]}`);
  return q?.grams ?? null;
}

function stripQuantityTokens(text) {
  return String(text || "")
    .replace(/\d+(?:[.,]\d+)?\s*(?:كيلو|كجم|ك|kg|جرام|جم|g|لتر|ل|liter|l|مل|ml)/gi, " ")
    .replace(PACK_RE, " ")
    .replace(PACK_ANY_RE, " ")
    .replace(EXTRA_RE, " ")
    // In Unilever-style lists, standalone "ق" means per piece, not part of the product name.
    .replace(/(?:^|\s)ق(?=\s|$)/giu, " ");
}

function numericPriceTokens(text) {
  const s = toAsciiDigits(text);
  const attached = [...s.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:جنيه|ج|EGP)(?=\s|\||$)/gi)].map(m => parseNumber(m[1]));
  const standalone = [...s.matchAll(/(?:^|\s|\|)(\d+(?:[.,]\d+)?)(?=\s|\||$)/gi)].map(m => parseNumber(m[1]));
  return [...attached, ...standalone].filter(n => n != null && n > 0 && n < 100000);
}

 
function selectSalePrice(text, fallbackPrices) {
  const s = toAsciiDigits(text);
  // Prefer the value explicitly labelled as wholesale when a row has multiple prices.
  const explicitWholesale = s.match(/(?:جمله|جملة)\s*[:：]?\s*(\d+(?:[.,]\d+)?)/i);
  const labelled = explicitWholesale ? parseNumber(explicitWholesale[1]) : null;
  if (labelled != null && labelled > 0 && labelled < 100000) return labelled;
  return fallbackPrices[0] ?? null;
}

function extractProductText(line) {
  return stripQuantityTokens(line)
    .replace(/\d+(?:[.,]\d+)?\s*(?:ج|جنيه|EGP)?/gi, " ")
    .replace(/\|/g, " ")
    .replace(/[+]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^(?:[-•.*]+)\s*/, "")
    .trim();
}

function extractPriceCandidates(text) {
  const lines = String(text || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const out = [];
  let company = null;
  let section = null;

  for (const line of lines) {
    if (/^\/|^[-_=.*]+$/.test(line)) continue;
    if (/^(?:شهر\s+)?(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)\s+20\d{2}$/iu.test(line)) continue;

    const normalized = normalizeArabic(line);
    const parsedLine = toAsciiDigits(line);
    const stripped = stripQuantityTokens(parsedLine);
    const numbers = numericPriceTokens(stripped);

    // Company and section headings establish context for weight-only rows such as "9 ك:".
    if (!numbers.length) {
      if (/^(?:الاسعار?|اسعار)\s*(?:هي\s*)?(?:جمله|قطاعي|مستهلك)$/iu.test(normalized)) continue;
      if (/^(?:اسعار)\s+/iu.test(normalized)) {
        const heading = line.replace(/^(?:أسعار|اسعار)\s+/iu, "").split(/[–—-]/)[0].trim();
        company = heading.replace(/^شركة\s+/iu, "").trim() || company;
        continue;
      }
      if (/اوتوماتيك|automatic/u.test(normalized)) { section = "أوتوماتيك"; continue; }
      if (/اوزان|شكاير|شكاره/u.test(normalized)) { section = "أوزان وشكاير"; continue; }
      if (/عبوات صغيره|العبوات الصغيره/u.test(normalized)) { section = "العبوات الصغيرة"; continue; }
      continue;
    }

    const kind = classifyPriceKind(line);
    const retailIndex = parsedLine.search(RETAIL_WORDS);
    const beforeRetail = retailIndex >= 0 ? parsedLine.slice(0, retailIndex) : parsedLine;
    const preRetailNumbers = numericPriceTokens(stripQuantityTokens(beforeRetail));
    // Skip retail-only observations, but keep a valid base/package price that precedes
    // a separate consumer-price column (e.g. "شكارة 10 ك: 618.35 | مستهلك 630").
    if (kind === "retail" && (preRetailNumbers.length === 0 || numbers.length <= preRetailNumbers.length)) continue;

    const packCount = parsePackCount(parsedLine);
    const extraWeightG = parseExtraWeight(parsedLine);
    const quantity = parsedLine.match(/\d+(?:[.,]\d+)?\s*(?:كيلو|كجم|ك|kg|جرام|جم|g|لتر|ل|liter|l|مل|ml)/i);
    const q = quantity ? parseQuantity(quantity[0]) : null;
    const decimalAutomaticWeight = parsedLine.match(/(?:^|\s)(\d+[.,]\d{1,3})\s*(?:كجم|ك)?\s*(?:اتوماتيك|اوتوماتيك)/i);
    const decimalAutomaticGrams = decimalAutomaticWeight ? Math.round(Number(decimalAutomaticWeight[1].replace(",", ".")) * 1000) : null;

    const explicitWholesale = /(?:جمله|جملة)\s*[:：]?\s*(\d+(?:[.,]\d+)?)/i.test(parsedLine);
    const salePrice = selectSalePrice(stripped, numbers);
    if (salePrice == null) continue;

    const consumerIndex = parsedLine.search(RETAIL_WORDS);
    const consumerSuffix = consumerIndex >= 0
      ? parsedLine.slice(consumerIndex).replace(RETAIL_WORDS, " ")
      : "";
    const consumerPrice = numericPriceTokens(stripQuantityTokens(consumerSuffix))[0] ?? null;

    const candidateName = extractProductText(parsedLine)
      .replace(/(?:جمله|جملة|مستهلك|قطاعي|تجزئه|تجزئة|سعر الاساس|السعر الاساسى)/giu, " ")
      .replace(/\s+/g, " ").trim();
    const weightLabel = quantity?.[0]?.trim() || (decimalAutomaticWeight ? decimalAutomaticWeight[1] : null);
    const productText = candidateName.length >= 2
      ? candidateName
      : [company, section, weightLabel].filter(Boolean).join(" ").trim();
    const normalizedProduct = normalizeArabic(productText);
    if (normalizedProduct.length < 2 || /^\d/.test(normalizedProduct)) continue;

    const priceKind = explicitWholesale ? "wholesale" : "wholesale_candidate";
    out.push({
      raw_line: line,
      company,
      section,
      product_text: productText,
      package_sale_price: salePrice,
      consumer_price: consumerPrice,
      price_kind: priceKind,
      weight_g: q?.grams ?? decimalAutomaticGrams,
      volume_ml: q?.milliliters ?? null,
      offer_extra_weight_g: extraWeightG,
      pack_count: packCount,
      confidence: explicitWholesale ? (new Set(numbers).size > 1 ? 0.65 : 0.92) : (consumerIndex >= 0 ? 0.65 : 0.55),
    });
  }
  return out;
}
function commercialMetrics(row) {
  const weight = Number(row.weight_g) || 0;
  const extra = Number(row.offer_extra_weight_g) || 0;
  const price = Number(row.package_sale_price) || 0;
  const count = Number(row.pack_count) || 1;
  const totalWeight = weight + extra;
  return {
    package_sale_price: price,
    piece_sale_price: count > 1 ? price / count : price,
    effective_weight_g: totalWeight || null,
    effective_price_per_kg: totalWeight > 0 ? price / (totalWeight / 1000) : null,
    effective_volume_ml: Number(row.volume_ml) || null,
  };
}

function fingerprint(row) {
  return crypto.createHash("sha256").update([
    normalizeArabic(row.product_text), row.weight_g || "", row.volume_ml || "", row.offer_extra_weight_g || "",
    row.pack_count || "", row.package_sale_price || "", row.price_kind || ""
  ].join("|")).digest("hex");
}

module.exports = { classifyPriceKind, parsePackCount, parseExtraWeight, extractPriceCandidates, commercialMetrics, fingerprint };
