"use strict";

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function toAsciiDigits(value) {
  return String(value ?? "")
    .replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, d => String(FA_DIGITS.indexOf(d)));
}

function normalizeArabic(value) {
  return toAsciiDigits(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[ـ]/g, "")
    .replace(/["'`]/g, "")
    .replace(/[|,؛،:()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value) {
  let s = toAsciiDigits(value).trim().replace(/جنيه|ج|egp/gi, "");
  // Distinguish thousands separators (1,147.58) from decimal commas (2,5).
  s = /,\d{3}(?:\.|$)/.test(s) && s.includes(".") ? s.replace(/,/g, "") : s.replace(/,/g, ".");
  s = s.replace(/[^0-9.\-]/g, "");
  if (!s || (s.match(/\./g) || []).length > 1) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseQuantity(value) {
  const s = normalizeArabic(value);
  const m = s.match(/(\d+(?:\.\d+)?)\s*(كجم|كيلو|ك|kg|جرام|جم|g|لتر|ل|liter|l|مل|ml)/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (["كجم", "كيلو", "ك", "kg"].includes(unit)) return { value: n, unit: "kg", grams: n * 1000, milliliters: null };
  if (["جرام", "جم", "g"].includes(unit)) return { value: n, unit: "g", grams: n, milliliters: null };
  if (["لتر", "ل", "liter", "l"].includes(unit)) return { value: n, unit: "l", grams: null, milliliters: n * 1000 };
  return { value: n, unit: "ml", grams: null, milliliters: n };
}

function parseWeightGrams(value) { return parseQuantity(value)?.grams ?? null; }
function parseVolumeMilliliters(value) { return parseQuantity(value)?.milliliters ?? null; }

function normalizePhone(value) {
  const s = toAsciiDigits(value).replace(/[^0-9+]/g, "");
  if (!s) return null;
  const digits = s.replace(/^\+/, "");
  return digits.length >= 10 && digits.length <= 15 ? s : null;
}

module.exports = { toAsciiDigits, normalizeArabic, parseNumber, parseQuantity, parseWeightGrams, parseVolumeMilliliters, normalizePhone };
