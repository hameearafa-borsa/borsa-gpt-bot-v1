"use strict";
const assert = require("node:assert/strict");
const { buildPriceMemory, resolveFromMemory } = require("../modules/price-memory");

const accepted = [
  { decision: "accepted", confidence: 0.94, product_text: "دوف", price_kind: "wholesale", package_sale_price: 121, weight_g: null, volume_ml: 350, offer_extra_weight_g: null, package_type: null, pack_count: 12, unit_price_type: "بالكرتونة", observed_at: "2026-10-30T10:00:00Z" },
  { decision: "accepted", confidence: 0.91, product_text: "دوف", price_kind: "wholesale", package_sale_price: 123, weight_g: null, volume_ml: 350, offer_extra_weight_g: null, package_type: null, pack_count: 12, unit_price_type: "بالكرتونة", observed_at: "2026-10-31T10:00:00Z" },
  { decision: "pending", confidence: 0.99, product_text: "دوف", price_kind: "retail", package_sale_price: 9, weight_g: null, volume_ml: 350, offer_extra_weight_g: null, package_type: null, pack_count: 1, unit_price_type: "بالقطعة" }
];
const memory = buildPriceMemory(accepted);
const candidate = {
  product_text: "دوف", price_kind: "wholesale_candidate", package_sale_price: 125,
  weight_g: null, volume_ml: 350, offer_extra_weight_g: null, package_type: null,
  pack_count: null, unit_price_type: null
};
const resolved = resolveFromMemory(candidate, memory);
assert.equal(resolved.resolved, true);
assert.equal(resolved.price_kind, "wholesale");
assert.equal(resolved.unit_price_type, "بالكرتونة");
assert.equal(resolved.pack_count, 12);
assert.equal(resolved.evidence_count, 2);

// A new row explicitly marked per-piece must not inherit carton classification or count.
const explicitPiece = resolveFromMemory({ ...candidate, unit_price_type: "بالقطعة" }, memory);
assert.equal(explicitPiece.matched, false);
assert.equal(explicitPiece.unit_conflict, true);
assert.equal(explicitPiece.pack_count, undefined);

// The inverse conflict is equally unsafe: piece history cannot resolve a carton price.
const pieceMemory = buildPriceMemory([
  { ...accepted[0], unit_price_type: "بالقطعة", pack_count: null }
]);
const explicitCarton = resolveFromMemory({ ...candidate, unit_price_type: "بالكرتونة" }, pieceMemory);
assert.equal(explicitCarton.matched, false);
assert.equal(explicitCarton.unit_conflict, true);

// Piece history may classify an unlabelled piece observation, but must never pass on a carton count.
const inferredPiece = resolveFromMemory(candidate, pieceMemory);
assert.equal(inferredPiece.resolved, true);
assert.equal(inferredPiece.unit_price_type, "بالقطعة");
assert.equal(inferredPiece.pack_count, null);

const differentSize = resolveFromMemory({
  product_text: "دوف", weight_g: null, volume_ml: 600,
  offer_extra_weight_g: null, package_type: null, pack_count: null
}, memory);
assert.equal(differentSize.matched, false, "different size must never inherit the old package memory");

const conflicting = buildPriceMemory([
  ...accepted.slice(0, 1),
  { ...accepted[0], unit_price_type: "بالقطعة" }
]);
assert.equal(resolveFromMemory(candidate, conflicting).resolved, false,
  "conflicting piece/carton history must stay unresolved");
assert.equal(resolveFromMemory({ ...candidate, unit_price_type: "بالقطعة" }, conflicting).pack_count, null,
  "mixed unit history must never transfer carton count to a piece candidate");

const retailAcceptedOnly = buildPriceMemory([
  { ...accepted[0], price_kind: "retail", unit_price_type: "بالقطعة", pack_count: 1 }
]);
assert.equal(resolveFromMemory(candidate, retailAcceptedOnly).matched, false,
  "accepted retail observations must never teach wholesale units or carton counts");
assert.equal(resolveFromMemory({
  ...candidate, price_kind: "retail"
}, memory).matched, false, "wholesale memory must never resolve a retail candidate");

const unknownKindOnly = buildPriceMemory([
  { ...accepted[0], price_kind: "unknown" }
]);
assert.equal(resolveFromMemory(candidate, unknownKindOnly).matched, false,
  "unknown commercial context must never teach price memory");

const pendingOnly = buildPriceMemory([{ ...accepted[2], decision: "pending" }]);
assert.equal(resolveFromMemory(candidate, pendingOnly).matched, false,
  "pending rows must never teach price memory");

const normalizedAliasMemory = buildPriceMemory([
  { ...accepted[0], product_text: "أريال", volume_ml: 500, weight_g: null }
]);
const normalizedAlias = resolveFromMemory({
  product_text: "اريال", price_kind: "wholesale_candidate", weight_g: null,
  volume_ml: 500, offer_extra_weight_g: null, package_type: null,
  pack_count: null, unit_price_type: null
}, normalizedAliasMemory);
assert.equal(normalizedAlias.matched, true);
assert.equal(normalizedAlias.resolved, true);

const familyAliasMemory = buildPriceMemory([
  { ...accepted[0], product_text: "بريكس ارضيات 25 جم", weight_g: 25, volume_ml: null }
]);
const familyAliasMatch = resolveFromMemory({
  ...accepted[0], product_text: "بريكس منظف ارضيات 25 جم", weight_g: 25, volume_ml: null,
  price_kind: "wholesale_candidate", decision: undefined, unit_price_type: null, pack_count: null
}, familyAliasMemory);
assert.equal(familyAliasMatch.matched, true);
assert.equal(familyAliasMatch.resolved, true);

const differentFamily = resolveFromMemory({
  ...accepted[0], product_text: "بريكس منظف اسطح 25 جم", weight_g: 25, volume_ml: null,
  price_kind: "wholesale_candidate", unit_price_type: null, pack_count: null
}, familyAliasMemory);
assert.equal(differentFamily.matched, false);

const differentUseVariant = buildPriceMemory([
  { ...accepted[0], product_text: "أريال 2 ك يدوي", weight_g: 2000, volume_ml: null }
]);
assert.equal(resolveFromMemory({
  ...accepted[0], product_text: "أريال 2 ك اتوماتيك", weight_g: 2000, volume_ml: null,
  price_kind: "wholesale_candidate", unit_price_type: null, pack_count: null
}, differentUseVariant).matched, false);

console.log("price-memory.test.js: OK");
