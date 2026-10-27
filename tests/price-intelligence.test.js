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
assert.equal(fieldRows[4].confidence, 0.65);
assert.equal(fieldRows[5].package_sale_price, 915.87);
assert.equal(fieldRows[5].confidence, 0.65);
assert.equal(fieldRows[4].price_kind, "wholesale");
assert.equal(fieldRows[4].confidence, 0.65);
assert.equal(fieldRows[5].price_kind, "wholesale");
assert.equal(fieldRows[5].confidence, 0.65);
assert.equal(fieldRows[6].package_sale_price, 42.33);
assert.equal(fieldRows[6].product_text, "سيجنال", "standalone ق is a per-piece marker, not part of the product name");
assert.deepEqual(extractPriceCandidates("شهر أكتوبر 2026"), [], "catalog month headers must not become price candidates");
const { deterministicList, buildListPrompt } = require("../modules/price-list");
const conversationalComment = "برضو فيه ب 10 و برضو في ب 25";
assert.deepEqual(deterministicList(conversationalComment), [], "conversation-only comments must be silently ignored");
assert.deepEqual(deterministicList("برضو فيه ب 10 جنيه و برضو في ب 25 جنيه"), [], "currency words do not turn commentary into price rows");
const mixedCommentList = deterministicList(`أسعار شركة أريال:
أريال ٢ك يدوي ٤٩٠ج ٤ق
${conversationalComment}`);
assert.equal(mixedCommentList.length, 1, "a comment under a valid list must not become a price row");
assert.equal(mixedCommentList[0].package_sale_price, 490);
assert.ok(!buildListPrompt(`أريال ٢ك يدوي ٤٩٠ج ٤ق
${conversationalComment}`).includes(conversationalComment), "commentary must be removed before optional AI extraction");


// A bare number such as 503 is not a product or a price observation by itself.
assert.deepEqual(extractPriceCandidates("503"), []);
assert.deepEqual(extractPriceCandidates("503\n"), []);

// Weight and product-use variant are part of product identity, not price noise.
const variants = extractPriceCandidates(`اريال ٢ ك يدوي ٤٩٠ج ٤ق
اريال ٢ ك + ٣٠٠ جم هدية ٥٢٠ج ٤ق
اريال 2.500 اتوماتيك 828ج 4ق
اريال 2.5ك اتوماتيك 828ج 4ق`);
assert.equal(variants.length, 4);
assert.equal(variants[0].weight_g, 2000);
assert.match(variants[0].product_text, /يدوي/);
assert.equal(variants[1].weight_g, 2000);
assert.equal(variants[1].offer_extra_weight_g, 300);
assert.equal(variants[2].weight_g, 2500);
assert.match(variants[2].product_text, /اتوماتيك/);
assert.equal(variants[3].weight_g, 2500);
assert.match(variants[3].product_text, /اتوماتيك/);
assert.notEqual(variants[0].product_text, variants[2].product_text);


console.log("price intelligence tests: OK");
