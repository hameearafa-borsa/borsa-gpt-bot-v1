"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeArabic } = require("./normalization");

function loadRegistry(file = path.join(__dirname, "../data/product-registry.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function aliasMatch(text, aliases = []) {
  const norm = normalizeArabic(text);
  return aliases.some((alias) => {
    const a = normalizeArabic(alias);
    return a && (norm === a || norm.includes(a));
  });
}

function resolve(text, registry = loadRegistry()) {
  const norm = normalizeArabic(text);
  const brand = (registry.brands || []).find((b) => aliasMatch(norm, b.aliases || [b.name_ar]));
  if (!brand) return { matched: false, normalized: norm, brand: null, family: null, confidence: 0 };
  const family = (registry.families || []).find((f) => f.brand_key === brand.key && aliasMatch(norm, f.aliases || [f.name_ar]));
  return {
    matched: true,
    normalized: norm,
    brand,
    family: family || null,
    confidence: family ? 0.95 : 0.8,
  };
}

module.exports = { loadRegistry, resolve };
