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
  assert.equal(metadata.company, "شركة يونيليفر");
  assert.equal(metadata.month, "أكتوبر 2026");
  assert.equal(metadata.priceType, "أسعار جملة");
  assert.equal(new Set(accepted.map(row => row.company)).size, 1, "sections must not be mistaken for different companies");
  assert.equal(parsed.length, 66, "every readable row in the current Unilever fixture must be retained");
  assert.equal(accepted.length, 66, "wholesale catalog rows should infer carton pricing when no per-piece marker exists, including the contextually corrected currency suffix");
  assert.equal(review.length, 0, "the only suspicious currency suffix is resolved by adjacent rows that use ج");
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
  assert.ok(accepted.some(row => /205 ح/.test(row.raw_line) && row.package_sale_price === 205), "the contextual currency typo should retain its source text and numeric price");

  const brandPath = path.join(__dirname, "..", "1793378540373.jpg");
  assert.ok(fs.existsSync(brandPath), "the committed Borsa logo must be present for real image rendering");
  const images = await renderPriceListImages({ company: metadata.company, items: accepted, watermark: "بورصة المنظفات لأصحاب المحلات", month: metadata.month, priceType: metadata.priceType });
  if (process.env.PRICE_LIST_VISUAL_QA_DIR) {
    fs.mkdirSync(process.env.PRICE_LIST_VISUAL_QA_DIR, { recursive: true });
    images.forEach((png, index) => fs.writeFileSync(path.join(process.env.PRICE_LIST_VISUAL_QA_DIR, `unilever-page-${index + 1}.png`), png));
  }
  assert.equal(images.length, Math.ceil(accepted.length / 22), "long lists should be split into readable pages");
  for (const png of images) {
    assert.ok(Buffer.isBuffer(png));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "output must have a real PNG signature");
    const m = await sharp(png).metadata();
    assert.equal(m.format, "png");
    assert.equal(m.width, 1200);
    assert.ok(m.height >= 250 && m.height <= 1200, "page height should remain readable and shareable");
    assert.equal(m.channels, 4);
    assert.ok(png.length > 1000, "rasterized image should not be an empty/mock buffer");
  }
  console.log(`price list real sharp rasterization test: OK (sharp ${sharp.versions.sharp}, ${accepted.length} accepted rows, ${review.length} review rows, ${images.length} real PNG pages)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
