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
    .replace(EXTRA_RE, " ");
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
    const kind = classifyPriceKind(line);
    if (kind === "retail") continue;

    const packCount = parsePackCount(line);
    const extraWeightG = parseExtraWeight(line);
    const stripped = stripQuantityTokens(line);
    const numbers = numericPriceTokens(stripped);
    if (!numbers.length) continue;

    const productText = extractProductText(line);
    const normalizedProduct = normalizeArabic(productText);
    if (normalizedProduct.length < 2 || /^\d/.test(normalizedProduct)) continue;
    if (/^(?:جنيه|ج|egp|ق|قطعه|قطعة)$/.test(normalizedProduct)) continue;

    const quantity = line.match(/\d+(?:[.,]\d+)?\s*(?:كيلو|كجم|ك|kg|جرام|جم|g|لتر|ل|liter|l|مل|ml)/i);
    const q = quantity ? parseQuantity(quantity[0]) : null;
    const priceKind = kind === "wholesale" ? "wholesale" : "wholesale_candidate";

    out.push({
      raw_line: line,
      product_text: productText,
      package_sale_price: selectSalePrice(stripped, numbers),
      price_kind: priceKind,
      weight_g: q?.grams ?? null,
      volume_ml: q?.milliliters ?? null,
      offer_extra_weight_g: extraWeightG,
      pack_count: packCount,
      confidence: kind === "wholesale" ? 0.92 : 0.55,
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
