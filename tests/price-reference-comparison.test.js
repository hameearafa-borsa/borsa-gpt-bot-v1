"use strict";

const assert = require("node:assert/strict");
const { compareReferencePrice, comparableName } = require("../modules/price-reference-comparison");

const signalReference = {
  price_kind: "wholesale",
  product_label: "سيجنال 120مل",
  weight_g: null,
  volume_ml: 120,
  package_sale_price: 42.33,
  wholesale_carton_price: null,
  consumer_price: null,
  pack_count: null,
  unit_price_type: "بالقطعة",
  raw_line: "سيجنال 120مل ق 42,33 ج"
};
const signalObservation = {
  price_kind: "wholesale",
  product_text: "سيجنال",
  weight_g: null,
  volume_ml: 120,
  package_sale_price: 45,
  pack_count: null,
  offer_extra_weight_g: null,
  unit_price_type: "بالقطعة"
};

assert.equal(comparableName("سيجنال ١٢٠مل"), "سيجنال");
const pieceComparison = compareReferencePrice(signalReference, signalObservation);
assert.equal(pieceComparison.comparable, true);
assert.equal(pieceComparison.referencePrice, 42.33);
assert.equal(pieceComparison.observedPrice, 45);
assert.equal(pieceComparison.difference, 2.67);
assert.equal(pieceComparison.direction, "above_reference");

assert.equal(
  compareReferencePrice(signalReference, { ...signalObservation, unit_price_type: "بالكرتونة" }).reason,
  "unit_type_mismatch",
  "piece prices must never be compared with carton totals"
);
assert.equal(
  compareReferencePrice(signalReference, { ...signalObservation, price_kind: "retail" }).reason,
  "price_kind_mismatch",
  "wholesale and retail prices must remain separate"
);
assert.equal(
  compareReferencePrice(signalReference, { ...signalObservation, volume_ml: 250 }).reason,
  "size_mismatch",
  "different sizes are different comparison subjects"
);
assert.equal(
  compareReferencePrice(signalReference, { ...signalObservation, product_text: "لوكس" }).reason,
  "product_identity_mismatch",
  "different products must not be matched just because price and size look similar"
);

const cartonReference = {
  price_kind: "wholesale",
  product_label: "بيرل أوتوماتيك 9 ك",
  weight_g: 9000,
  volume_ml: null,
  package_sale_price: 487.4,
  wholesale_carton_price: null,
  consumer_price: null,
  pack_count: 4,
  unit_price_type: "بالكرتونة",
  raw_line: "بيرل أوتوماتيك 9 ك 487.40 ج 4ق"
};
const cartonObservation = {
  price_kind: "wholesale",
  product_text: "بيرل أوتوماتيك",
  weight_g: 9000,
  volume_ml: null,
  package_sale_price: 500,
  pack_count: 4,
  offer_extra_weight_g: null,
  unit_price_type: "بالكرتونة"
};
const cartonComparison = compareReferencePrice(cartonReference, cartonObservation);
assert.equal(cartonComparison.comparable, true);
assert.equal(cartonComparison.difference, 12.6);
assert.equal(cartonComparison.differencePercent, 2.59);
assert.equal(
  compareReferencePrice(cartonReference, { ...cartonObservation, pack_count: null }).reason,
  "carton_count_mismatch_or_unknown",
  "unknown carton count prevents unsafe comparison"
);
assert.equal(
  compareReferencePrice(cartonReference, { ...cartonObservation, pack_count: 6 }).reason,
  "carton_count_mismatch_or_unknown",
  "different carton configurations must not be compared as equal units"
);
assert.equal(
  compareReferencePrice({ ...cartonReference, raw_line: "بيرل 9 ك + 500 جم 500 ج 4ق" }, cartonObservation).reason,
  "reference_offer_needs_structured_metadata",
  "promotional extra quantity must not be compared as the base product"
);
assert.equal(
  compareReferencePrice(cartonReference, { ...cartonObservation, offer_extra_weight_g: 300 }).reason,
  "observation_offer_mismatch",
  "an observed extra-weight offer must not be compared to a base reference"
);

const unchanged = compareReferencePrice(signalReference, { ...signalObservation, package_sale_price: 42.33 });
assert.equal(unchanged.comparable, true);
assert.equal(unchanged.direction, "equal_to_reference");
assert.equal(unchanged.differencePercent, 0);

console.log("price reference comparison tests: OK");
