"use strict";
const assert = require("node:assert/strict");
const { extractList, isListLike } = require("../modules/price-list");
const text = `أسعار برسيل\nالأسعار بالقطعة\nأوتوماتيك\nبرسيل 2 كيلو 100 جنيه\nبرسيل 3 كيلو 140 جنيه\nبرسيل 5 كيلو 220 جنيه`;
const singleLineCatalog = "أسعار شركة يونيليفر " + Array.from({ length: 12 }, (_, i) => `صنف ${i + 1} ${100 + i} جم ${20 + i},50 ج`).join(" • ");
assert.equal(isListLike(singleLineCatalog), true, "single-line pasted catalogs with many priced rows should be accepted");
assert.equal(isListLike("أسعار شركة برسيل\nبرسيل 2 كيلو 100 جنيه\nبرسيل 3 كيلو 140 جنيه"), true,
  "a short but clearly headed two-row catalog should be accepted");
assert.equal(isListLike("برسيل 2 كيلو 100\nبرسيل 3 كيلو 140\nبرسيل 5 كيلو 220"), true,
  "three product-price rows without currency suffixes should be accepted");
assert.equal(isListLike("برضو فيه ب 10 و برضو في ب 25"), false, "conversational price mentions must not be treated as a catalog");
(async () => {
  let calls = 0;
  const result = await extractList({ generate: async () => { calls++; return { text: "{}" }; } }, text);
  assert.equal(calls, 0, "clean 3+ product list should be parsed locally without API usage");
  assert.equal(result.method, "deterministic");
  assert.ok(result.items.filter(x => x.decision === "accepted").length >= 3);

  // Unit-price section headings carry forward until another unit heading appears.
  const { deterministicList, detectUnitPriceHeading } = require("../modules/price-list");
  assert.equal(detectUnitPriceHeading("الأسعار بالقطعة"), "بالقطعة");
  assert.equal(detectUnitPriceHeading("الأسعار بالكرتونة"), "بالكرتونة");

  // Company catalogs default to carton prices, while explicit ق rows remain per-piece.
  const companyCatalog = deterministicList(`قائمة أسعار شركة يونيليفر
الصنف السعر
سيجنال 120مل 42,33 ج
كلوز أب 50مل ق 29,19 ج
كلير أكياس 5 مل 346 ج
`);
  assert.equal(companyCatalog.length, 3);
  assert.deepEqual(companyCatalog.map(x => x.unit_price_type), ["بالكرتونة", "بالقطعة", "بالكرتونة"]);
  assert.equal(companyCatalog[0].package_sale_price, 42.33);
  assert.equal(companyCatalog[1].package_sale_price, 29.19);
  assert.equal(companyCatalog[2].package_sale_price, 346);
  assert.equal(companyCatalog[0].company, "شركة يونيليفر");
  assert.equal(companyCatalog[2].company, "شركة يونيليفر", "column labels must not replace the company identity");

  const bundleCount = deterministicList(`قائمة أسعار شركة اختبار
منظف 2 ك 4 كيس 120 ج
منظف 1 ك 6 قطعة 90 ج
`);
  assert.deepEqual(bundleCount.map(x => x.pack_count), [4, 6], "explicit package counts should be retained");
  const sectionUnits = deterministicList(`أسعار شركة يونيليفر
الأسعار بالقطعة
سيجنال 120مل 42,33 ج
كلوز أب 50مل 29,19 ج
الأسعار بالكرتونة
كلير 900مل 275 ج
كلير أكياس 5 مل الكرتونة 346 ج
الأسعار بالقطعة
دوف 180مل 75,27 ج`);
  assert.deepEqual(sectionUnits.map(x => x.unit_price_type), [
    "بالقطعة", "بالقطعة", "بالكرتونة", "بالكرتونة", "بالقطعة"
  ], "unit-price type should persist through rows and change only at a new heading");
  assert.equal(sectionUnits[3].package_sale_price, 346, "carton heading must not cause package size 5 ml to be mistaken for the price");

  const aiContext = await extractList({
    generate: async () => ({ text: JSON.stringify({ items: [
      { raw_line: "سيجنال 120مل 42,33 ج", product: "سيجنال 120مل", package_sale_price: 42.33, unit_price_type: "بالكرتونة", decision: "accepted" },
      { raw_line: "كلير 900مل 275 ج", product: "كلير 900مل", package_sale_price: 275, unit_price_type: "بالقطعة", decision: "accepted" }
    ] }) })
  }, `أسعار شركة يونيليفر
الأسعار بالقطعة
سيجنال 120مل 42,33 ج
الأسعار بالكرتونة
كلير 900مل 275 ج`);
  assert.deepEqual(aiContext.items.map(x => x.unit_price_type), ["بالقطعة", "بالكرتونة"],
    "validated deterministic section context must override contradictory AI unit labels");

  const fallbackText = `أسعار شركة برسيل
برسيل 2 كيلو 100 جنيه
برسيل 3 كيلو 140 جنيه`;
  const empty = await extractList({ generate: async () => ({ text: JSON.stringify({ company: "شركة برسيل", items: [] }) }) }, fallbackText);
  assert.equal(empty.method, "fallback", "empty AI arrays must fall back to local parsing");
  assert.ok(empty.items.length >= 2, "empty AI arrays must not discard locally parseable rows");

  const unusable = await extractList({ generate: async () => ({ text: JSON.stringify({ items: [{ product: "", package_sale_price: null, decision: "accepted" }] }) }) }, fallbackText);
  assert.equal(unusable.method, "fallback", "AI output with no usable rows must fall back locally");
  assert.ok(unusable.items.length >= 2, "unusable AI output must preserve locally parseable rows");
  console.log("price list deterministic-first and empty-AI fallback tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
