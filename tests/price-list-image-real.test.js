"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { deterministicList, parseListMetadata } = require("../modules/price-list");
const { renderPriceListImages } = require("../modules/price-list-image");

(async () => {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures-unilever-oct-2026.txt"), "utf8");
  const metadata = parseListMetadata(fixture);
  const parsed = deterministicList(fixture);
  const accepted = parsed.filter(row => row.decision === "accepted");
  const review = parsed.filter(row => row.decision === "review");
  const renderRows = parsed.filter(row => row.decision !== "skipped");
  assert.equal(metadata.company, "شركة يونيليفر");
  assert.equal(metadata.month, "أكتوبر 2026");
  assert.equal(metadata.priceType, "أسعار جملة");
  assert.equal(new Set(accepted.map(row => row.company)).size, 1, "sections must not be mistaken for different companies");
  assert.equal(parsed.length, 66, "every readable row in the current Unilever fixture must be retained");
  assert.equal(accepted.length, 62, "unambiguous rows including the ح currency typo should be accepted");
  assert.equal(review.length, 4, "only ambiguous bundle and gift offers should be held for review");
  assert.equal(parsed.filter(row => row.decision === "skipped").length, 0, "no priced row should be silently skipped");
  assert.ok(accepted.every(row => row.unit_price_type === "بالقطعة" || row.unit_price_type === "بالكرتونة"),
    "accepted rows must have a verified per-piece or carton sale unit");
  assert.ok(accepted.some(row => /سيجنال 120مل/.test(row.raw_line) && row.unit_price_type === "بالقطعة"),
    "explicit per-piece markers should be retained");
  assert.ok(accepted.some(row => /كلير أكياس 5 مل الكرتونة/.test(row.raw_line) && row.unit_price_type === "بالكرتونة"),
    "explicit carton wording should be retained as carton pricing");
  assert.ok(accepted.some(row => /جلو 40جم/.test(row.raw_line) && row.unit_price_type === "بالكرتونة"),
    "unmarked rows in a named wholesale catalog must be recorded as carton prices");
  assert.ok(accepted.some(row => /لوكس 115جم/.test(row.raw_line) && row.unit_price_type === "بالكرتونة"),
    "the carton offer note in the soap section should establish carton pricing for following soap rows");
  const typoCurrencyRow = parsed.find(row => /205 ح/.test(row.raw_line));
  assert.equal(typoCurrencyRow?.decision, "accepted", "a trailing ح should be accepted as Egyptian-pound currency");
  assert.equal(typoCurrencyRow?.package_sale_price, 205);
  assert.equal(parsed.find(row => row.raw_line === "صانسيلك 350 + بلسم  ق 159 ج")?.package_sale_price, 159);
  assert.equal(parsed.find(row => row.raw_line === "تريزيمي 400 + بلسم ق 276 ج")?.package_sale_price, 276);

  const brandPath = path.join(__dirname, "..", "1793378540373.jpg");
  assert.ok(fs.existsSync(brandPath), "the committed Borsa logo must be present for real image rendering");
  const images = await renderPriceListImages({ company: metadata.company, items: renderRows, watermark: "بورصة المنظفات لأصحاب المحلات", month: metadata.month, priceType: metadata.priceType });
  if (process.env.PRICE_LIST_VISUAL_QA_DIR) {
    fs.mkdirSync(process.env.PRICE_LIST_VISUAL_QA_DIR, { recursive: true });
    images.forEach((png, index) => fs.writeFileSync(path.join(process.env.PRICE_LIST_VISUAL_QA_DIR, `unilever-page-${index + 1}.png`), png));
  }
  assert.equal(images.length, Math.ceil(renderRows.length / 30), "long lists should be split into readable pages");
  for (const png of images) {
    assert.ok(Buffer.isBuffer(png));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "output must have a real PNG signature");
    const m = await sharp(png).metadata();
    assert.equal(m.format, "png");
    assert.equal(m.width, 2880, "144 DPI output should provide a crisp high-resolution image");
    assert.ok(m.height >= 1200 && m.height <= 4200, "page height should remain readable and shareable");
    assert.equal(m.channels, 4);
    assert.ok(png.length > 1000, "rasterized image should not be an empty/mock buffer");
  }

  const baheyFixture = [
    "/قائمة",
    "أسعار شركة باهي",
    "شهر نوفمبر 2026",
    "الأسعار جملة",
    "دوش 60 جم*48 329.28",
    "دوش 110 جم*48 612.50",
    "ريفولي 110 جم*48 660.52",
    "ريفولي 165 جم*24 476.28",
    "باهي 105/115 جم*20 152.26",
    "باهي 105/115 جم*12 90.18",
    "باهي 185/185 جم*8 91.33",
    "باهي 2 كجم + 300 جم*4 473.34"
  ].join("\n");
  const baheyMetadata = parseListMetadata(baheyFixture);
  const baheyRows = deterministicList(baheyFixture);
  console.log("BAHEY_REVIEW_DIAGNOSTIC " + JSON.stringify(baheyRows.filter(row => row.decision !== "accepted").map(row => ({raw_line: row.raw_line, product: row.product, price: row.package_sale_price, unit: row.unit_price_type, decision: row.decision}))));
  assert.equal(baheyMetadata.company, "شركة باهي");
  assert.equal(baheyMetadata.month, "نوفمبر 2026");
  assert.equal(baheyMetadata.priceType, "أسعار جملة");
  assert.equal(baheyRows.length, 8, "all eight transcribed Bahey source rows must be retained");
  assert.ok(baheyRows.every(row => row.decision === "accepted"), "clear rows in the named wholesale list must be accepted");
  assert.deepEqual(baheyRows.map(row => row.product), ["دوش 60 جم", "دوش 110 جم", "ريفولي 110 جم", "ريفولي 165 جم", "باهي 105/115 جم", "باهي 105/115 جم", "باهي 185/185 جم", "باهي 2 كجم + 300 جم"],
    "package size must be part of product identity so different sizes are not merged");
  assert.deepEqual(baheyRows.map(row => row.pack_count), [48, 48, 48, 24, 20, 12, 8, 4],
    "compact *N carton counts must be parsed");
  assert.equal(baheyRows[0].package_label, "60 جم · 48 قطعة");
  assert.equal(baheyRows[0].weight_g, 60, "weight remains available as structured data");
  assert.equal(baheyRows[4].package_label, "105/115 جم · 20 قطعة");
  assert.equal(baheyRows[7].package_label, "2 كجم · 300 جم · 4 قطعة",
    "promotional extra weight must remain visible in package details");
  const baheyImages = await renderPriceListImages({
    company: baheyMetadata.company, items: baheyRows,
    watermark: "بورصة المنظفات لأصحاب المحلات", month: baheyMetadata.month,
    priceType: baheyMetadata.priceType
  });
  assert.equal(baheyImages.length, 1, "Bahey visual QA should produce at least one image");
  const baheyPng = baheyImages[0];
  assert.deepEqual([...baheyPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  if (process.env.PRICE_LIST_VISUAL_QA_DIR) {
    fs.writeFileSync(path.join(process.env.PRICE_LIST_VISUAL_QA_DIR, "bahey-page-1.png"), baheyPng);
  }
  const baheyImageMeta = await sharp(baheyPng).metadata();
  assert.equal(baheyImageMeta.format, "png");
  assert.equal(baheyImageMeta.width, 2880, "Bahey PNG should use high-resolution rasterization");
  console.log(`Bahey real-list parser and image test: OK (${baheyRows.length} rows, ${baheyImages.length} PNG page)`);

  console.log(`price list real sharp rasterization test: OK (sharp ${sharp.versions.sharp}, ${accepted.length} accepted rows, ${review.length} review rows, ${images.length} real PNG pages)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
