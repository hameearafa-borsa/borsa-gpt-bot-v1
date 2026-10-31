"use strict";

const assert = require("node:assert/strict");
const sharp = require("sharp");
const { fetchCatalogImage } = require("../modules/catalog-page-ocr");
const { createImageOcr } = require("../modules/image-ocr");

const catalogUrl = "https://snapflyer.io/eg/downtown/offers/metro-market/1325";
const pageNumber = 12;
const imageUrl = "https://snapflyer.io/storage/flyers/eg/metro-market/2026-10/flyer_1325/pages/page_12.webp";
const modes = ["6", "11"];
const columns = 3;
const rows = 3;
const overlap = 0.025;

(async () => {
  console.log("Live Metro catalog crop OCR experiment");
  console.log("Catalog: " + catalogUrl);
  console.log("Page: " + pageNumber + " | grid: " + columns + "x" + rows + " | overlap: " + (overlap * 100) + "%");
  const image = await fetchCatalogImage(imageUrl, { timeoutMs: 30000 });
  const oriented = await sharp(image).rotate().toBuffer();
  const metadata = await sharp(oriented).metadata();
  assert.ok(metadata.width && metadata.height, "Could not read page dimensions");
  console.log("Page dimensions: " + metadata.width + "x" + metadata.height);

  const cellWidth = Math.ceil(metadata.width / columns);
  const cellHeight = Math.ceil(metadata.height / rows);
  const crops = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const left = Math.max(0, Math.floor(column * cellWidth - cellWidth * overlap));
      const top = Math.max(0, Math.floor(row * cellHeight - cellHeight * overlap));
      const right = Math.min(metadata.width, Math.ceil((column + 1) * cellWidth + cellWidth * overlap));
      const bottom = Math.min(metadata.height, Math.ceil((row + 1) * cellHeight + cellHeight * overlap));
      const crop = await sharp(oriented).extract({ left, top, width: right - left, height: bottom - top }).jpeg({ quality: 94 }).toBuffer();
      crops.push({ id: "R" + (row + 1) + "C" + (column + 1), left, top, width: right - left, height: bottom - top, buffer: crop });
    }
  }

  for (const mode of modes) {
    console.log("\\n========== CROP OCR PSM " + mode + " ==========");
    const ocr = createImageOcr({ timeoutMs: 35000, pageSegmentationMode: mode });
    for (const crop of crops) {
      const result = await ocr.extract(crop.buffer, {
        storeKey: "metro_market", catalogUrl, fingerprint: "snapflyer-metro-1325",
        pageNumber, region: crop.id
      });
      console.log("\\n--- " + crop.id + " | x=" + crop.left + " y=" + crop.top +
        " w=" + crop.width + " h=" + crop.height + " | chars=" + result.characterCount + " ---");
      console.log(result.text || "[NO TEXT RECOGNIZED]");
    }
  }
  console.log("\\nLIVE METRO CATALOG CROP OCR EXPERIMENT: OK");
})().catch(error => {
  console.error("LIVE METRO CATALOG CROP OCR EXPERIMENT: FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
