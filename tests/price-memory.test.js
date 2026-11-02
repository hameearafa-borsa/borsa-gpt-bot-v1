"use strict";
const assert = require("node:assert/strict");
const { buildPriceMemory, resolveFromMemory } = require("../modules/price-memory");

const accepted = [
  { decision: "accepted", confidence: 0.94, product_text: "دوف", price_kind: "wholesale", package_sale_price: 121, weight_g: null, volume_ml: 350, offer_extra_weight_g: null, package_type: null, pack_count: 12, unit_price_type: "بالكرتونة", observed_at: "2026-10-30T10:00:00Z" },
  { decision: "accepted", confidence: 0.91, product_text: "دوف", price_kind: "wholesale", package_sale_price: 123, weight_g: null, volume_ml: 350, offer_extra_weight_g: null, package_type: null, pack_count: 12, unit_price_type: "بالكرتونة", observed_at: "2026-10-31T10:00:00Z" },
  { decision: "pending", confidence: 0.99, product_text: "دوف", price_kind: "retail", package_sale_price: 9, weight_g: null, volume_ml: 350, offer_extra_weight_g: null, package_type: null, pack_count: 1, unit_price_type: "بالقطعة" }
];
const memory = buildPriceMemory(accepted);
const resolved = resolveFromMemory({
  product_text: "دوف", price_kind: "wholesale_candidate", package_sale_price: 125,
  weight_g: null, volume_ml: 350, offer_extra_weight_g: null, package_type: null,
  pack_count: null, unit_price_type: null
}, memory);
assert.equal(resolved.resolved, true);
assert.equal(resolved.price_kind, "wholesale");
assert.equal(resolved.unit_price_type, "بالكرتونة");
assert.equal(resolved.pack_count, 12);
assert.equal(resolved.evidence_count, 2);

const differentSize = resolveFromMemory({
  product_text: "دوف", weight_g: null, volume_ml: 600,
  offer_extra_weight_g: null, package_type: null, pack_count: null
}, memory);
assert.equal(differentSize.matched, false, "different size must never inherit the old package memory");

const conflicting = buildPriceMemory([
  ...accepted.slice(0, 1),
  { ...accepted[0], unit_price_type: "بالقطعة" }
]);
assert.equal(resolveFromMemory({
  product_text: "دوف", price_kind: "wholesale_candidate", weight_g: null, volume_ml: 350,
  offer_extra_weight_g: null, package_type: null, pack_count: null, unit_price_type: null
}, conflicting).resolved, false, "conflicting piece/carton history must stay unresolved");

const retailAcceptedOnly = buildPriceMemory([
  { ...accepted[0], price_kind: "retail", unit_price_type: "بالقطعة", pack_count: 1 }
]);
assert.equal(resolveFromMemory({
  product_text: "دوف", price_kind: "wholesale_candidate", weight_g: null, volume_ml: 350,
  offer_extra_weight_g: null, package_type: null, pack_count: null, unit_price_type: null
}, retailAcceptedOnly).matched, false,
"accepted retail observations must never teach wholesale units or carton counts");
assert.equal(resolveFromMemory({
  product_text: "دوف", price_kind: "retail", weight_g: null, volume_ml: 350,
  offer_extra_weight_g: null, package_type: null, pack_count: null, unit_price_type: null
}, memory).matched, false,
"wholesale memory must never resolve a retail candidate");

const unknownKindOnly = buildPriceMemory([
  { ...accepted[0], price_kind: "unknown" }
]);
assert.equal(resolveFromMemory({
  product_text: "دوف", price_kind: "wholesale_candidate", weight_g: null, volume_ml: 350,
  offer_extra_weight_g: null, package_type: null, pack_count: null, unit_price_type: null
}, unknownKindOnly).matched, false,
"unknown commercial context must never teach price memory");

const pendingOnly = buildPriceMemory([{ ...accepted[2], decision: "pending" }]);
assert.equal(resolveFromMemory({
  product_text: "دوف", weight_g: null, volume_ml: 350,
  offer_extra_weight_g: null, package_type: null
}, pendingOnly).matched, false, "pending rows must never teach price memory");


const normalizedAliasMemory = buildPriceMemory([
  { ...accepted[0], product_text: "أريال", volume_ml: 500, weight_g: null }
]);
const normalizedAlias = resolveFromMemory({
  product_text: "اريال", price_kind: "wholesale_candidate", weight_g: null,
  volume_ml: 500, offer_extra_weight_g: null, package_type: null,
  pack_count: null, unit_price_type: null
}, normalizedAliasMemory);
assert.equal(normalizedAlias.matched, true, "Arabic spelling variants should use normalized product memory");
assert.equal(normalizedAlias.resolved, true);

console.log("price-memory.test.js: OK");
