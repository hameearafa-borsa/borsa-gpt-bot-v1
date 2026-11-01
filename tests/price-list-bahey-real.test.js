"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { deterministicList, parseListMetadata } = require("../modules/price-list");
const { renderPriceListImages } = require("../modules/price-list-image");

(async () => {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures-bahey-nov-2026.txt"), "utf8");
  const metadata = parseListMetadata(fixture);
  const parsed = deterministicList(fixture);
  const accepted = parsed.filter(row => row.decision === "accepted");
  const review = parsed.filter(row => row.decision === "review");
  const skipped = parsed.filter(row => row.decision === "skipped");

  assert.equal(metadata.company, "شركة باهي");
  assert.equal(metadata.month, "نوفمبر 2026");
  assert.equal(metadata.isCompanyCatalog, true);
  assert.ok(accepted.length >= 40, "the readable Bahey price rows should be retained without an AI call");
  assert.ok(accepted.every(row => row.unit_price_type === "بالكرتونة"),
    "unmarked rows in this named company price list should retain the catalog carton-price context");

  const expected = [
    ["باهى 185 جم 8 كيس 91.33", 91.33],
    ["برايت 10 لتر 238.14", 238.14],
    ["باهى 2ك + 300 جم * 4 كيس 473.34", 473.34],
    ["باهى 1ك + 115جم   * 6 كيس 359.56", 359.56],
    ["باهى 2.5كجم + 300 جم * 4 كيس 617.41", 617.41],
    ["برايت مطهر للاسطح 10 لتر 199.43", 199.43]
  ];
  for (const [raw, price] of expected) {
    const row = accepted.find(item => item.raw_line === raw);
    assert.ok(row, `expected row should be accepted: ${raw}`);
    assert.equal(row.package_sale_price, price, `source price must be preserved: ${raw}`);
  }

  assert.ok(!parsed.some(row => row.raw_line.includes("ريفولى شاور جل 45 جم * 50 كيس")),
    "the visibly truncated row without a price must not be invented or rendered");
  assert.equal(accepted.length + review.length + skipped.length, parsed.length,
    "every parsed price row must have an explicit decision");

  const images = await renderPriceListImages({
    company: metadata.company, items: accepted, watermark: "بورصة المنظفات لأصحاب المحلات",
    month: metadata.month, priceType: metadata.priceType || "أسعار جملة"
  });
  assert.equal(images.length, Math.ceil(accepted.length / 16), "long Bahey list should split into readable pages");
  const outputDir = process.env.PRICE_LIST_TEST_OUTPUT_DIR;
  if (outputDir) fs.mkdirSync(outputDir, { recursive: true });
  for (const [index, png] of images.entries()) {
    if (outputDir) fs.writeFileSync(path.join(outputDir, `bahey-nov-2026-page-${index + 1}.png`), png);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "output must be a real PNG");
    const image = await sharp(png).metadata();
    assert.equal(image.format, "png");
    assert.equal(image.width, 1200);
    assert.ok(image.height >= 250 && image.height <= 1200);
    assert.ok(png.length > 1000);
  }
  console.log(`Bahey visual QA: ${accepted.length} accepted, ${review.length} review, ${skipped.length} skipped, ${images.length} PNG pages (sharp ${sharp.versions.sharp})`);
})().catch(error => { console.error(error); process.exitCode = 1; });
