"use strict";
const assert = require("node:assert/strict");
const { extractPriceCandidates, commercialMetrics, parsePackageType, productIdentityKey, classifyObservationChange } = require("../modules/price-intelligence");
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
assert.equal(fieldRows[4].package_sale_price, 505.31, "the first amount is the package price, not the later labelled column");
assert.equal(fieldRows[4].explicit_wholesale_label_price, 487.4, "keep the labelled wholesale amount separately");
assert.equal(fieldRows[4].needs_review, true, "conflicting price columns must remain reviewable");
assert.equal(fieldRows[4].confidence, 0.82);
assert.equal(fieldRows[5].package_sale_price, 308.43, "a later carton/wholesale column must not overwrite the package price");
assert.equal(fieldRows[5].explicit_wholesale_label_price, 915.87);
assert.equal(fieldRows[5].needs_review, true);
assert.equal(fieldRows[5].confidence, 0.82);
assert.equal(fieldRows[4].price_kind, "wholesale");
assert.equal(fieldRows[4].confidence, 0.82);
assert.equal(fieldRows[5].price_kind, "wholesale");
assert.equal(fieldRows[5].confidence, 0.82);
assert.equal(fieldRows[6].package_sale_price, 42.33);
assert.equal(fieldRows[6].product_text, "سيجنال", "standalone ق is a per-piece marker, not part of the product name");
assert.deepEqual(extractPriceCandidates("شهر أكتوبر 2026"), [], "catalog month headers must not become price candidates");
const { deterministicList, buildListPrompt, parseListMetadata } = require("../modules/price-list");
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


const pearlOctober = `أسعار بيرل – أكتوبر
..... أوتوماتيك
• 9 ك: 505.31 | جملة 487.40 | مستهلك 525
• 5 ك: 308.43 | جملة 915.87 | مستهلك 325
• 2.5 ك: 179.15 | جملة 716.63 | مستهلك 200
..... أوزان وشكاير
• شكارة 10 ك: 618.35 | مستهلك 630
• شكارة 7 ك: 432.84 | مستهلك 450
• 2 ك: 129.22 | جملة 516.90 | مستهلك 145
• 1.5 ك: 98.96 | جملة 395.85 | مستهلك 110
• 1 ك: 66.28 | جملة 265.15 | مستهلك 75
.. العبوات الصغيرة
• 290 جم: 22.03 | جملة 176.29 | مستهلك 25
• 160 جم: 12 | جملة 144.06 | مستهلك 15
• 120 جم: 8.46 | جملة 135.49 | مستهلك 10
• 50 جم: 3.96 | جملة 47.52 | مستهلك 5
• 30 جم: 3.79 | جملة 75.95 | مستهلك 5`;
assert.equal(parseListMetadata(pearlOctober).month, "أكتوبر", "month in a company-list title should be retained even without an explicit year");
const pearlRows = extractPriceCandidates(pearlOctober);
assert.equal(pearlRows.length, 13, "Pearl October list should yield 13 sale-price observations");
assert.deepEqual(pearlRows.map(row => row.package_sale_price), [505.31, 308.43, 179.15, 618.35, 432.84, 129.22, 98.96, 66.28, 22.03, 12, 8.46, 3.96, 3.79], "the monitor must retain the first package-price column instead of blindly selecting the later labelled amount");
assert.deepEqual(pearlRows.slice(0, 3).map(row => row.explicit_wholesale_label_price), [487.40, 915.87, 716.63]);
assert.ok(pearlRows.slice(0, 3).every(row => row.needs_review), "multi-price rows with differing labelled and package amounts must be flagged for review");
assert.equal(pearlRows[11].explicit_wholesale_label_price, 47.52);
assert.equal(pearlRows[12].explicit_wholesale_label_price, 75.95);
assert.equal(pearlRows[0].weight_g, 9000);
assert.equal(pearlRows[1].weight_g, 5000);
assert.equal(pearlRows[2].weight_g, 2500);
assert.equal(pearlRows[3].weight_g, 10000);
assert.match(pearlRows[3].product_text, /بيرل/u, "a sack is packaging, not the product name");
assert.doesNotMatch(pearlRows[3].product_text, /^شكاره$/u, "generic sack wording must not become a standalone product identity");
assert.equal(pearlRows[3].package_type, "sack");
assert.equal(pearlRows[3].price_kind, "wholesale", "unlabelled sack rows inherit the repeated wholesale context of the same section");
assert.equal(pearlRows[4].price_kind, "wholesale");
assert.equal(pearlRows[3].context_inferred_price_kind, true);
assert.equal(pearlRows[4].context_inferred_price_kind, true);
assert.equal(pearlRows[0].company, "بيرل");
assert.equal(pearlRows[0].section, "أوتوماتيك");
assert.match(pearlRows[0].product_text, /بيرل/u, "a numeric price must not become the product name");
assert.doesNotMatch(pearlRows[0].product_text, /505[.]31/u, "the unlabeled numeric amount belongs to price review, not product identity");
assert.equal(pearlRows[0].consumer_price, 525);
assert.equal(pearlRows[3].consumer_price, 630);
assert.ok(pearlRows.every(row => row.package_sale_price !== row.consumer_price), "consumer column must not replace the observed sale price");
const pearlListRows = deterministicList(pearlOctober);
assert.equal(pearlListRows.length, 13, "Pearl company-list parser should preserve all 13 rows");
assert.equal(pearlListRows[9].category, "العبوات الصغيرة", "small-pack section heading must not overwrite the company context");
assert.equal(pearlListRows.filter(row => row.decision === "accepted").length, 13, "Pearl rows with company, section and weight context should be accepted");
assert.equal(pearlListRows[0].package_sale_price, 505.31);
assert.equal(pearlListRows[0].wholesale_carton_price, 487.40);
assert.equal(pearlListRows[0].consumer_price, 525);
assert.equal(pearlListRows[0].weight_g, 9000);
assert.equal(pearlListRows[3].package_sale_price, 618.35);
assert.equal(pearlListRows[3].consumer_price, 630);

// Historical comparison preserves product identity when only weight/offer changes.
const historyBase = {
  brand_key: "pearl",
  product_text: "بيرل أوتوماتيك 9 ك",
  product_identity_key: "pearl|بيرل اوتوماتيك|wholesale",
  price_kind: "wholesale",
  package_sale_price: 487.40,
  weight_g: 9000,
  offer_extra_weight_g: null,
  volume_ml: null,
  pack_count: null,
  package_type: null
};
assert.equal(classifyObservationChange(null, historyBase), "new_observation");
assert.equal(classifyObservationChange(historyBase, { ...historyBase }), "same_observation");
assert.equal(classifyObservationChange(historyBase, { ...historyBase, package_sale_price: 500 }), "price_change");
assert.equal(classifyObservationChange(historyBase, { ...historyBase, weight_g: 9500 }), "weight_change");
assert.equal(classifyObservationChange(historyBase, { ...historyBase, weight_g: 9500, package_sale_price: 500 }), "price_and_weight_change");
assert.equal(classifyObservationChange(historyBase, { ...historyBase, brand_key: "other", product_identity_key: "other|بيرل اوتوماتيك|wholesale" }), "new_observation");
assert.equal(classifyObservationChange(historyBase, { ...historyBase, price_kind: "retail", product_identity_key: "pearl|بيرل اوتوماتيك|retail" }), "new_observation");
assert.equal(parsePackageType("شكارة 10 ك"), "sack");
assert.equal(parsePackageType("كيس 50 جم"), "sachet");
assert.equal(parsePackageType("9 ك"), null);
assert.equal(productIdentityKey({ ...historyBase, product_text: "بيرل أوتوماتيك 5 ك" }), productIdentityKey({ ...historyBase, product_text: "بيرل أوتوماتيك 9 ك" }), "weight should not change stable product identity");

console.log("price intelligence tests: OK");
