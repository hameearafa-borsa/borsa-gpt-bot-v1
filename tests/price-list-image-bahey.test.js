"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { deterministicList, parseListMetadata } = require("../modules/price-list");

(async () => {
  const fixture = [
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
  const metadata = parseListMetadata(fixture);
  const rows = deterministicList(fixture);
  assert.equal(metadata.company, "شركة باهي");
  assert.equal(metadata.month, "نوفمبر 2026");
  assert.equal(metadata.priceType, "أسعار جملة");
  assert.equal(rows.length, 8, "all eight Bahey source rows must be retained");
  assert.ok(rows.every(row => row.decision === "accepted"), "clear rows in the declared wholesale list should be accepted");
  assert.deepEqual(rows.map(row => row.product), [
    "دوش 60 جم", "دوش 110 جم", "ريفولي 110 جم", "ريفولي 165 جم",
    "باهي 105/115 جم", "باهي 105/115 جم", "باهي 185/185 جم", "باهي 2 كجم + 300 جم"
  ], "different sizes and offer weights must remain distinct product identities");
  assert.deepEqual(rows.map(row => row.pack_count), [48, 48, 48, 24, 20, 12, 8, 4]);
  assert.equal(rows[0].weight_g, 60);
  assert.equal(rows[0].package_label, "60 جم · 48 قطعة");
  assert.equal(rows[7].package_label, "2 كجم · 300 جم · 4 قطعة");

  const isTermuxOrAndroid =
    process.platform === "android" ||
    /(^|\/)com\.termux(\/|$)/i.test(String(process.env.PREFIX || ""));

  if (isTermuxOrAndroid) {
    console.log("Bahey parser tests: OK (8 accepted rows). Real PNG rendering skipped on Termux.");
    return;
  }

  const sharp = require("sharp");
  const { renderPriceListImages } = require("../modules/price-list-image");

  const logoPath = path.join(__dirname, "..", "1793300250521.jpg");
  assert.ok(fs.existsSync(logoPath), "the main-branch Borsa logo must exist for real rendering");
  const images = await renderPriceListImages({
    company: metadata.company, items: rows, watermark: "بورصة المنظفات لأصحاب المحلات",
    month: metadata.month, priceType: metadata.priceType, pageSize: 25, logoPlacement: "both", logoPath
  });
  assert.equal(images.length, 1, "the eight-row Bahey list should render to one image");
  const png = images[0];
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 1200);
  assert.ok(meta.height >= 250 && meta.height <= 1200);
  assert.equal(meta.channels, 4);
  assert.ok(png.length > 1000);
  if (process.env.PRICE_LIST_VISUAL_QA_DIR) {
    fs.mkdirSync(process.env.PRICE_LIST_VISUAL_QA_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PRICE_LIST_VISUAL_QA_DIR, "bahey-nov-2026-page-1.png"), png);
  }
  console.log("Bahey list parser and real PNG rendering: OK (8 accepted rows, one image)");
})().catch(error => { console.error(error); process.exitCode = 1; });
