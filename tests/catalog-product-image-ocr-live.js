"use strict";

const assert = require("node:assert/strict");
const { safeCatalogPageImageUrl, fetchCatalogImage } = require("../modules/catalog-page-ocr");
const { createImageOcr } = require("../modules/image-ocr");

const productUrl = "https://snapflyer.io/eg/downtown/products/191790";
const expected = {
  title: "Metro Tissues 400 Sheets x 3 Packs",
  currentPrice: "74.99",
  store: "Metro Market"
};
const MAX_HTML_BYTES = 2_000_000;

async function fetchProductPage(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "snapflyer.io" ||
      !/^\/eg\/[a-z0-9-]+\/products\/\d+$/i.test(parsed.pathname)) {
    throw new Error("snapflyer_product_url_not_allowed");
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { accept: "text/html,application/xhtml+xml" }
  });
  if (!response.ok) throw new Error("product_page_http_" + response.status);
  const type = response.headers.get("content-type") || "";
  if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) {
    throw new Error("product_page_unexpected_content_type");
  }
  const html = await response.text();
  if (!html || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    throw new Error("product_page_empty_or_too_large");
  }
  return html;
}

function extractSnippetImageUrls(html, baseUrl) {
  const candidates = new Set();
  const patterns = [
    /(?:https?:\/\/snapflyer\.io)?\/storage\/flyers\/[^\s"'<>\\]+/gi,
    /(?:src|data-src|content)\s*=\s*["']([^"']+)["']/gi
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const raw = (match[1] || match[0]).replace(/&amp;/g, "&");
      const safe = safeCatalogPageImageUrl(raw, baseUrl);
      if (safe && /\/snippets\//i.test(new URL(safe).pathname)) candidates.add(safe);
    }
  }
  return [...candidates];
}

(async () => {
  console.log("Live SnapFlyer individual-product image OCR experiment");
  console.log("Product page: " + productUrl);
  const html = await fetchProductPage(productUrl);
  assert.ok(html.includes(expected.title), "Expected product title is missing from product page");
  assert.ok(html.includes(expected.currentPrice), "Expected current price is missing from product page");
  // SnapFlyer exposes store identity in the product's Open Graph image path,
  // using a store slug rather than the display name "Metro Market".
  const images = extractSnippetImageUrls(html, productUrl);
  assert.ok(images.length, "No safe individual snippet image URL found on product page");
  const storeImage = images.find(url =>
    /\\/metro-market\\/2026-10\\/flyer_1325\\/snippets\\//i.test(new URL(url).pathname)
  );
  assert.ok(
    storeImage,
    "No product-page snippet image tied to Metro Market catalog 1325"
  );

  console.log("Product metadata: " + expected.title + " | " + expected.store + " | " + expected.currentPrice + " EGP");
  console.log("Individual snippet images found: " + images.length);
  console.log("Validated store/catalog image: " + storeImage);

  const image = await fetchCatalogImage(storeImage, { timeoutMs: 30000 });
  const ocr = createImageOcr({ timeoutMs: 60000, pageSegmentationMode: "6" });
  const result = await ocr.extract(image, {
    storeKey: "metro_market",
    catalogUrl: productUrl,
    fingerprint: "snapflyer-product-191790",
    pageNumber: 4,
    productId: "191790"
  });

  console.log("\n--- Individual product image OCR ---");
  console.log(result.text || "[NO TEXT RECOGNIZED]");
  console.log("\nOCR characters: " + result.characterCount);
  assert.ok(result.hasText, "OCR returned no text for the individual product image");
  console.log("LIVE SNAPFLYER INDIVIDUAL-PRODUCT OCR: OK (page metadata and image OCR succeeded)");
})().catch(error => {
  console.error("LIVE SNAPFLYER INDIVIDUAL-PRODUCT OCR: FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
