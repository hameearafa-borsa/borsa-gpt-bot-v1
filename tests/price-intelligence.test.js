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

console.log("price intelligence tests: OK");
