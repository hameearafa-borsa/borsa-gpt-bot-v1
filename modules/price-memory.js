"use strict";

const { normalizeArabic } = require("../core/normalization");

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function canonicalProductText(text) {
  const normalized = normalizeArabic(text || "");
  if (!normalized) return "";
  const { resolve } = require("../core/product-registry");
  const match = resolve(text);
  if (!match.matched || !match.brand) return normalized;

  // Canonicalize only a known leading brand/family alias. Keep every remaining
  // descriptor intact so different product variants are never merged by brand alone.
  const aliases = match.family
    ? [match.family.name_ar, ...(match.family.aliases || [])]
    : [match.brand.name_ar, ...(match.brand.aliases || [])];
  const ordered = aliases.map(alias => normalizeArabic(alias)).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const alias = ordered.find(value => normalized === value || normalized.startsWith(value + " "));
  if (!alias) return normalized;
  const canonical = match.family ? match.family.key : match.brand.key;
  return canonical + normalized.slice(alias.length);
}

function dimensionKey(row) {
  return [
    canonicalProductText(row.product_text || ""),
    numberOrNull(row.weight_g),
    numberOrNull(row.volume_ml),
    numberOrNull(row.offer_extra_weight_g),
    String(row.package_type || "")
  ].join("|");
}

function buildPriceMemory(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    // Only accepted, high-confidence wholesale observations may teach the resolver.
    if (row.decision !== "accepted" || row.price_kind !== "wholesale") continue;
    if (Number(row.confidence) < 0.8) continue;
    if (!row.product_text || !Number.isFinite(Number(row.package_sale_price)) || Number(row.package_sale_price) <= 0) continue;
    const key = dimensionKey(row);
    const group = groups.get(key) || { count: 0, kinds: new Set(), units: new Set(), packCounts: new Set(), latest: null };
    group.count += 1;
    if (row.price_kind) group.kinds.add(row.price_kind);
    if (row.unit_price_type) group.units.add(row.unit_price_type);
    if (numberOrNull(row.pack_count) != null) group.packCounts.add(numberOrNull(row.pack_count));
    if (!group.latest || new Date(row.observed_at || 0) > new Date(group.latest.observed_at || 0)) group.latest = row;
    groups.set(key, group);
  }
  return groups;
}

function resolveFromMemory(candidate, memory) {
  if (candidate?.price_kind === "retail" || candidate?.price_kind === "unknown") {
    return { matched: false, confidence: 0 };
  }
  const group = memory?.get(dimensionKey(candidate));
  if (!group || group.count < 1) return { matched: false, confidence: 0 };
  const kinds = [...group.kinds];
  const units = [...group.units];
  const packCounts = [...group.packCounts];
  const priceKind = kinds.length === 1 ? kinds[0] : null;
  const unitPriceType = units.length === 1 ? units[0] : null;

  // An explicit piece/carton marker on the new observation must agree with
  // accepted history. Never let carton history silently classify a piece price
  // (or transfer carton quantity) and vice versa.
  if (candidate.unit_price_type && units.length && !units.includes(candidate.unit_price_type)) {
    return { matched: false, confidence: 0, unit_conflict: true };
  }

  const resolvedUnit = candidate.unit_price_type || unitPriceType;
  // Pack counts describe cartons only. Do not copy them to piece-priced rows,
  // nor infer a count from mixed unit histories.
  const mayInheritPackCount = resolvedUnit === "بالكرتونة" &&
    units.length === 1 && units[0] === "بالكرتونة" && packCounts.length === 1;
  const packCount = candidate.pack_count == null && mayInheritPackCount
    ? packCounts[0]
    : candidate.pack_count;

  return {
    matched: true,
    confidence: priceKind && priceKind !== "unknown" && resolvedUnit ? 0.94 : 0.72,
    price_kind: priceKind,
    unit_price_type: resolvedUnit || null,
    pack_count: packCount,
    evidence_count: group.count,
    resolved: Boolean(priceKind && priceKind !== "unknown" && resolvedUnit)
  };
}

module.exports = { canonicalProductText, dimensionKey, buildPriceMemory, resolveFromMemory };
