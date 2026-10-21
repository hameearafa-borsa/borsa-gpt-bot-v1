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
  assert.ok(accepted.length >= 60, "the long fixture should retain the clear product rows");
  assert.ok(accepted.some(row => row.unit_price_type === "بالقطعة"), "explicit per-piece markers should be retained");
  assert.ok(review.some(row => /205 ح/.test(row.raw_line)), "ambiguous currency suffix must be sent to review, not silently accepted");

  const images = await renderPriceListImages({ company: metadata.company, items: accepted, watermark: "بورصة المنظفات لأصحاب المحلات", month: metadata.month, priceType: metadata.priceType });
  assert.equal(images.length, Math.ceil(accepted.length / 14), "long lists should be split into readable pages");
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
