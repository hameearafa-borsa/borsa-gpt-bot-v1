"use strict";

const assert = require("node:assert/strict");
const sharp = require("sharp");
const { fetchCatalogImage } = require("../modules/catalog-page-ocr");
const { createImageOcr } = require("../modules/image-ocr");

const catalogUrl = "https://snapflyer.io/eg/downtown/offers/metro-market/1325";
const pageNumber = 12;
const imageUrl = "https://snapflyer.io/storage/flyers/eg/metro-market/2026-10/flyer_1325/pages/page_12.webp";

// Coordinates are mapped from the reviewed 720x1000 page preview to the
// downloaded image dimensions. Each rectangle includes the price, product,
// and printed pack/name caption for one complete offer card.
const previewWidth = 720;
const previewHeight = 1000;
const regions = [
  { id: "dove-spray-150ml", x: 45, y: 48, width: 185, height: 190 },
  { id: "nivea-roll-on", x: 235, y: 48, width: 220, height: 190 },
  { id: "sensodyne-toothpaste", x: 42, y: 238, width: 195, height: 185 },
  { id: "axe-spray-150ml", x: 465, y: 125, width: 225, height: 180 }
];

(async () => {
  console.log("Live Metro complete offer-card OCR experiment");
  console.log("Catalog: " + catalogUrl);
  console.log("Page: " + pageNumber + " | regions: " + regions.map(region => region.id).join(", "));

  const image = await fetchCatalogImage(imageUrl, { timeoutMs: 30000 });
  const oriented = await sharp(image).rotate().toBuffer();
  const metadata = await sharp(oriented).metadata();
  assert.ok(metadata.width && metadata.height, "Could not read page dimensions");

  const scaleX = metadata.width / previewWidth;
  const scaleY = metadata.height / previewHeight;
  console.log("Page dimensions: " + metadata.width + "x" + metadata.height);
  console.log("Preview mapping scale: x=" + scaleX.toFixed(4) + " y=" + scaleY.toFixed(4));

  const ocr = createImageOcr({ timeoutMs: 60000, pageSegmentationMode: "6" });
  let recognizedCards = 0;

  for (const region of regions) {
    const left = Math.max(0, Math.floor(region.x * scaleX));
    const top = Math.max(0, Math.floor(region.y * scaleY));
    const right = Math.min(metadata.width, Math.ceil((region.x + region.width) * scaleX));
    const bottom = Math.min(metadata.height, Math.ceil((region.y + region.height) * scaleY));
    const crop = await sharp(oriented)
      .extract({ left, top, width: right - left, height: bottom - top })
      .jpeg({ quality: 96 })
      .toBuffer();

    const result = await ocr.extract(crop, {
      storeKey: "metro_market",
      catalogUrl,
      fingerprint: "snapflyer-metro-1325",
      pageNumber,
      region: region.id
    });

    if (result.hasText) recognizedCards++;
    console.log("\n--- " + region.id + " | x=" + left + " y=" + top +
      " w=" + (right - left) + " h=" + (bottom - top) +
      " | chars=" + result.characterCount + " | PSM 6 ---");
    console.log(result.text || "[NO TEXT RECOGNIZED]");
  }

  assert.ok(recognizedCards > 0, "No text recognized in any complete offer-card crop");
  console.log("\nLIVE METRO COMPLETE OFFER-CARD OCR EXPERIMENT: OK (" +
    recognizedCards + "/" + regions.length + " regions returned text)");
})().catch(error => {
  console.error("LIVE METRO COMPLETE OFFER-CARD OCR EXPERIMENT: FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
