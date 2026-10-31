"use strict";

const assert = require("node:assert/strict");
const { fetchCatalogImage } = require("../modules/catalog-page-ocr");
const { createImageOcr } = require("../modules/image-ocr");

const catalogUrl = "https://snapflyer.io/eg/downtown/offers/metro-market/1489";
const imageUrl = "https://snapflyer.io/storage/flyers/eg/metro-market/2026-10/flyer_1489/pages/page_2.webp";

(async () => {
  console.log("Live catalog OCR integration test");
  console.log("Store: metro_market");
  console.log("Catalog: " + catalogUrl);
  console.log("Page: 2");
  console.log("Image: " + imageUrl);

  const image = await fetchCatalogImage(imageUrl, { timeoutMs: 30000 });
  console.log("Downloaded image bytes: " + image.length);

  const ocr = createImageOcr({ timeoutMs: 60000 });
  const result = await ocr.extract(image, {
    storeKey: "metro_market",
    catalogUrl,
    fingerprint: "snapflyer-metro-1489",
    pageNumber: 2
  });

  console.log("OCR engine: " + result.engine);
  console.log("OCR language: " + result.language);
  console.log("OCR character count: " + result.characterCount);
  console.log("--- OCR TEXT START ---");
  console.log(result.text || "[NO TEXT RECOGNIZED]");
  console.log("--- OCR TEXT END ---");

  assert.ok(result.hasText, "Tesseract returned no text for the real Metro page image");
  assert.ok(result.characterCount >= 10, "OCR output is unexpectedly short");
  console.log("LIVE METRO PAGE OCR: OK");
})().catch(error => {
  console.error("LIVE METRO PAGE OCR: FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
