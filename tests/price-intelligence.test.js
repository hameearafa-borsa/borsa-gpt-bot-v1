"use strict";
const assert = require("node:assert/strict");
const { extractPriceCandidates, commercialMetrics } = require("../modules/price-intelligence");
const { normalizeArabic, parseWeightGrams } = require("../core/normalization");

assert.equal(normalizeArabic("أوكسي ٢ كجم"), "اوكسي 2 كجم");
assert.equal(parseWeightGrams("٢.٥ كيلو"), 2500);

const rows = extractPriceCandidates(`أريال ٢ك يدوي ٤٩٠ج ٤ق\nبريكس ارضيات ٢٥ جم ١٨.٧٥ ج\nبريكس 1 لتر مستهلك 55 ج`);
assert.ok(rows.length >= 2);
assert.equal(rows[0].pack_count, 4);
assert.equal(rows[0].package_sale_price, 490);
assert.equal(commercialMetrics(rows[0]).piece_sale_price, 122.5);
assert.equal(rows.some((r) => r.raw_line.includes("مستهلك")), false);

const offer = extractPriceCandidates("مسحوق X 2 كجم + 500 جم 110ج")[0];
assert.equal(offer.offer_extra_weight_g, 500);
assert.equal(commercialMetrics(offer).package_sale_price, 110);
assert.equal(commercialMetrics(offer).effective_weight_g, 2500);

const arabicOffer = extractPriceCandidates("مسحوق X ٢ك + ٥٠٠ جم ١١٠ج")[0];
assert.equal(arabicOffer.weight_g, 2000);
assert.equal(arabicOffer.offer_extra_weight_g, 500);
assert.equal(arabicOffer.package_sale_price, 110);

 
// Real-world list variants: Arabic digits, decimal commas, per-piece prices,
// and multi-column rows with a clearly labelled wholesale value.
const fieldRows = extractPriceCandidates(`اريال 25 جم 12.75 ج
اوكسي 50 جم 18,75 ج
جيل 25 جم 2.4909 ج
اريال ٢ك يدوي ٤٩٠ج ٤ق
بيرل 9 ك: 505.31 | جملة 487.40 | مستهلك 525
بيرل 5 ك: 308.43 | جملة 915.87 | مستهلك 325
سيجنال 120مل ق 42,33 ج`);
assert.equal(fieldRows.length, 7);
assert.equal(fieldRows[0].package_sale_price, 12.75);
assert.equal(fieldRows[1].package_sale_price, 18.75);
assert.equal(fieldRows[2].package_sale_price, 2.4909);
assert.equal(fieldRows[3].package_sale_price, 490);
assert.equal(fieldRows[3].pack_count, 4);
assert.equal(fieldRows[3].weight_g, 2000);
assert.equal(fieldRows[4].package_sale_price, 487.4);
assert.equal(fieldRows[5].package_sale_price, 915.87);
assert.equal(fieldRows[6].package_sale_price, 42.33);

console.log("price intelligence tests: OK");
