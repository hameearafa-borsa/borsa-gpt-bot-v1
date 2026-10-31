"use strict";

const assert = require("node:assert/strict");
const { fetchCatalogImage } = require("../modules/catalog-page-ocr");
const { createImageOcr } = require("../modules/image-ocr");

const catalogUrl = "https://snapflyer.io/eg/downtown/offers/metro-market/1325";
const pageNumbers = [10, 11, 12];
const imageBase = "https://snapflyer.io/storage/flyers/eg/metro-market/2026-10/flyer_1325/pages/page_";

(async () => {
  console.log("Live Metro detergent and personal-care catalog OCR test");
  console.log("Store: metro_market");
  console.log("Catalog: " + catalogUrl);
  console.log("Pages: " + pageNumbers.join(", "));

  const ocr = createImageOcr({ timeoutMs: 60000 });
  let pagesWithText = 0;

  for (const pageNumber of pageNumbers) {
    const imageUrl = imageBase + pageNumber + ".webp";
    console.log("\n=== METRO CATALOG PAGE " + pageNumber + " ===");
    console.log("Image: " + imageUrl);

    const image = await fetchCatalogImage(imageUrl, { timeoutMs: 30000 });
    console.log("Downloaded image bytes: " + image.length);

    const result = await ocr.extract(image, {
      storeKey: "metro_market",
      catalogUrl,
      fingerprint: "snapflyer-metro-1325",
      pageNumber
    });

    console.log("OCR engine: " + result.engine);
    console.log("OCR language: " + result.language);
    console.log("OCR character count: " + result.characterCount);
    console.log("--- OCR TEXT START page=" + pageNumber + " ---");
    console.log(result.text || "[NO TEXT RECOGNIZED]");
    console.log("--- OCR TEXT END page=" + pageNumber + " ---");

    assert.ok(result.hasText, "Tesseract returned no text for Metro page " + pageNumber);
    assert.ok(result.characterCount >= 20, "OCR output is unexpectedly short for Metro page " + pageNumber);
    pagesWithText++;
  }

  assert.equal(pagesWithText, pageNumbers.length, "Not all selected Metro catalog pages produced OCR text");
  console.log("LIVE METRO DETERGENT CATALOG OCR: OK");
})().catch(error => {
  console.error("LIVE METRO DETERGENT CATALOG OCR: FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
