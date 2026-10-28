"use strict";

const assert = require("node:assert/strict");
const {
  compareReferencePrice, comparableName, compareObservationToLatestReference,
  persistObservationReferenceComparison
} = require("../modules/price-reference-comparison");

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
  compareReferencePrice(
    { ...signalReference, product_label: "سيجنال 120مل +25مل", raw_line: "سيجنال 120مل +25مل" },
    signalObservation
  ).reason,
  "reference_offer_needs_structured_metadata",
  "extra millilitres must not be compared as the base product even when the offer label is missing"
);
assert.equal(
  compareReferencePrice(
    { ...cartonReference, raw_line: "بيرل أوتوماتيك 9 ك 1104 ج العرض على الكرتونة قطعة صابون هدية" },
    cartonObservation
  ).reason,
  "reference_offer_needs_structured_metadata",
  "a carton with a free soap gift must not be compared as the plain carton"
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

// Price selection must respect whether the reference is a piece or carton price.
assert.equal(compareReferencePrice(
  { ...cartonReference, unit_price_type: "بالقطعة", package_sale_price: 120, wholesale_carton_price: 480 },
  { ...cartonObservation, unit_price_type: "بالقطعة", package_sale_price: 125, pack_count: null }
).referencePrice, 120, "a per-piece reference must not accidentally use the carton total");

const retailPiece = compareReferencePrice(
  { ...signalReference, price_kind: "retail", unit_price_type: "بالقطعة", package_sale_price: 600, consumer_price: 14 },
  { ...signalObservation, price_kind: "retail", package_sale_price: 15 }
);
assert.equal(retailPiece.referencePrice, 14, "retail piece comparison must use the consumer piece price, not a separate carton total");
const retailCarton = compareReferencePrice(
  { ...cartonReference, price_kind: "retail", package_sale_price: 600, consumer_price: 14 },
  { ...cartonObservation, price_kind: "retail", package_sale_price: 620 }
);
assert.equal(retailCarton.referencePrice, 600, "retail carton comparison must use the carton price, not the consumer piece price");

// Database-backed lookup considers only the same kind, unit and exact size before
// performing strict product-identity matching in JavaScript.
(async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("FROM price_reference_observations")) {
        return { rows: [
          { ...signalReference, id: 101, company_label: "يونيليفر", source_period: "أكتوبر 2026", created_at: "2026-10-01" },
          { ...signalReference, id: 100, company_label: "يونيليفر", source_period: "سبتمبر 2026", package_sale_price: 40, created_at: "2026-09-01" }
        ], rowCount: 2 };
      }
      if (sql.includes("UPDATE price_observations")) return { rows: [], rowCount: 1 };
      throw new Error("unexpected comparison persistence query");
    }
  };
  const dbComparison = await compareObservationToLatestReference(pool, signalObservation);
  assert.equal(dbComparison.comparable, true);
  assert.equal(dbComparison.referenceObservationId, 101);
  assert.equal(dbComparison.sourcePeriod, "أكتوبر 2026");
  assert.equal(dbComparison.difference, 2.67);
  assert.equal(queries[0].params[0], "wholesale");
  assert.equal(queries[0].params[1], "بالقطعة");
  assert.equal(queries[0].params[3], 120);

  const savedComparison = await persistObservationReferenceComparison(pool, 9001, signalObservation);
  assert.equal(savedComparison.comparable, true);
  assert.equal(queries.at(-1).params[0], 101);
  assert.equal(queries.at(-1).params[1], 42.33);
  assert.equal(queries.at(-1).params[2], 2.67);
  assert.equal(queries.at(-1).params[4], "comparable");
  assert.equal(queries.at(-1).params[6], 9001);
  assert.match(queries.at(-1).sql, /reference_compared_at=NOW/);

  const noReferencePool = { async query(sql) {
    assert.match(sql, /FROM price_reference_observations/);
    return { rows: [], rowCount: 0 };
  } };
  const noMatch = await compareObservationToLatestReference(noReferencePool, signalObservation);
  assert.equal(noMatch.comparable, false);
  assert.equal(noMatch.status, "not_comparable");

  console.log("price reference comparison and database persistence tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
