"use strict";

const assert = require("node:assert/strict");
const { fetchCatalogImage } = require("../modules/catalog-page-ocr");
const { createImageOcr } = require("../modules/image-ocr");

const catalogUrl = "https://snapflyer.io/eg/downtown/offers/metro-market/1325";
const pageNumbers = [10, 11, 12];
const imageBase = "https://snapflyer.io/storage/flyers/eg/metro-market/2026-10/flyer_1325/pages/page_";
const modes = ["6", "11"];

(async () => {
  console.log("Live Metro catalog OCR comparison: PSM 6 vs PSM 11");
  console.log("Catalog: " + catalogUrl);
  console.log("Pages: " + pageNumbers.join(", "));
  for (const mode of modes) {
    const ocr = createImageOcr({ timeoutMs: 120000, pageSegmentationMode: mode });
    for (const pageNumber of pageNumbers) {
      const imageUrl = imageBase + pageNumber + ".webp";
      const image = await fetchCatalogImage(imageUrl, { timeoutMs: 30000 });
      const result = await ocr.extract(image, { storeKey: "metro_market", catalogUrl, fingerprint: "snapflyer-metro-1325", pageNumber });
      console.log("\\n=== PSM " + mode + " PAGE " + pageNumber + " ===");
      console.log("OCR character count: " + result.characterCount);
      console.log(result.text || "[NO TEXT RECOGNIZED]");
      assert.ok(result.hasText, "PSM " + mode + " returned no text for page " + pageNumber);
      assert.ok(result.characterCount >= 20, "PSM " + mode + " output too short for page " + pageNumber);
    }
  }
  console.log("LIVE METRO CATALOG OCR PSM COMPARISON: OK");
})().catch(error => { console.error("LIVE METRO CATALOG OCR PSM COMPARISON: FAILED"); console.error(error?.stack || error); process.exitCode = 1; });
