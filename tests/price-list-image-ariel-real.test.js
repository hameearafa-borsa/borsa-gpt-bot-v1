"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { deterministicList, parseListMetadata } = require("../modules/price-list");
const { renderPriceListImages } = require("../modules/price-list-image");

(async () => {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures-ariel-nov-2026.txt"), "utf8");
  const metadata = parseListMetadata(fixture);
  const parsed = deterministicList(fixture);
  const accepted = parsed.filter(row => row.decision === "accepted");
  const review = parsed.filter(row => row.decision === "review");
  const skipped = parsed.filter(row => row.decision === "skipped");
  assert.ok(metadata.company, "Ariel company must be recognized");
  assert.ok(/نوفمبر 2026/.test(metadata.month), "November 2026 must be recognized");
  assert.equal(parsed.length, 77, "all supplied Ariel source rows must be retained for audit");
  assert.ok(accepted.length >= 65, "most rows should be deterministically accepted");
  assert.equal(skipped.length, 0, "no priced source row should disappear silently");
  assert.ok(accepted.some(row => /اريال 50 جرام/.test(row.raw_line) && /32 كيس/.test(row.package_label)), "bag counts must survive in labels");
  assert.ok(accepted.some(row => /بامبرز ماكسي مقاس 1/.test(row.raw_line) && /3 شنطة/.test(row.package_label) && /60 حفاضة/.test(row.package_label)), "diaper bundle composition must be preserved");
  assert.ok(accepted.some(row => /فيري اقراص 20/.test(row.raw_line) && /5 وحدات/.test(row.package_label)), "unit counts must be retained");
  assert.ok(accepted.some(row => /ماكينة بلوتو بلس 10\+4/.test(row.raw_line)), "promotional multipacks must remain in product identity");
  assert.ok(accepted.some(row => /شامبو بانتين 200 مل/.test(row.raw_line) && row.unit_price_type === "بالقطعة"), "explicit piece prices must remain piece prices");
  assert.ok(accepted.some(row => /اريال جل 1.8 لتر/.test(row.raw_line) && row.unit_price_type === "بالكرتونة"), "company list carton price inference must be retained");
  const images = await renderPriceListImages({ company: metadata.company, items: accepted, watermark: "بورصة المنظفات لأصحاب المحلات", month: metadata.month, priceType: metadata.priceType || "قائمة أسعار" });
  assert.equal(images.length, Math.ceil(accepted.length / 16), "long Ariel list should split into readable pages");
  const outputDir = process.env.PRICE_LIST_TEST_OUTPUT_DIR;
  if (outputDir) fs.mkdirSync(outputDir, { recursive: true });
  for (const [index, png] of images.entries()) {
    if (outputDir) fs.writeFileSync(path.join(outputDir, `ariel-nov-2026-page-${index + 1}.png`), png);
    assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10], "output must be a real PNG");
    const meta = await sharp(png).metadata();
    assert.equal(meta.format, "png");
    assert.equal(meta.width, 1200);
    assert.equal(meta.channels, 4);
    assert.ok(meta.height >= 250 && meta.height <= 1200);
    assert.ok(png.length > 1000);
  }
  console.log(`Ariel November 2026 visual QA: OK (${parsed.length} source rows, ${accepted.length} accepted, ${review.length} review, ${skipped.length} skipped, ${images.length} pages)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
