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
  for (const line of lines) {
    if (/^\//.test(line) || /^[-_=.*]+$/.test(line)) continue;
    // Catalog metadata must never become a price observation (e.g. "شهر أكتوبر 2026").
    if (/^(?:شهر\s+)?(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)\s+20\d{2}$/iu.test(line)) continue;
    const kind = classifyPriceKind(line);
    if (kind === "retail") continue;

    const parsedLine = toAsciiDigits(line);
    const packCount = parsePackCount(parsedLine);
    const extraWeightG = parseExtraWeight(parsedLine);
    const stripped = stripQuantityTokens(parsedLine);
    const numbers = numericPriceTokens(stripped);
    if (!numbers.length) continue;

    const productText = extractProductText(parsedLine);
    const normalizedProduct = normalizeArabic(productText);
    if (normalizedProduct.length < 2 || /^\d/.test(normalizedProduct)) continue;
    if (/^(?:جنيه|ج|egp|ق|قطعه|قطعة)$/.test(normalizedProduct)) continue;

    const quantity = parsedLine.match(/\d+(?:[.,]\d+)?\s*(?:كيلو|كجم|ك|kg|جرام|جم|g|لتر|ل|liter|l|مل|ml)/i);
    const q = quantity ? parseQuantity(quantity[0]) : null;
    // In this catalog format, "2.500 اتوماتيك" denotes a 2.5 kg pack even without a unit suffix.
    const decimalAutomaticWeight = parsedLine.match(/(?:^|\s)(\d+[.,]\d{1,3})\s*(?:كجم|ك)?\s*(?:اتوماتيك|اوتوماتيك)/i);
    const decimalAutomaticGrams = decimalAutomaticWeight ? Math.round(Number(decimalAutomaticWeight[1].replace(",", ".")) * 1000) : null;
    const priceKind = kind === "wholesale" ? "wholesale" : "wholesale_candidate";

    out.push({
      raw_line: line,
      product_text: productText,
      package_sale_price: selectSalePrice(stripped, numbers),
      price_kind: priceKind,
      weight_g: q?.grams ?? decimalAutomaticGrams,
      volume_ml: q?.milliliters ?? null,
      offer_extra_weight_g: extraWeightG,
      pack_count: packCount,
      // Multiple distinct amounts on one row can mean carton/piece/retail columns or a bad source list.
      // Preserve the explicitly labelled wholesale value, but leave the row pending for review.
      confidence: kind === "wholesale" ? (new Set(numbers).size > 1 ? 0.65 : 0.92) : 0.55,
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
