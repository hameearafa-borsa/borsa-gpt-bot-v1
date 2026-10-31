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
  // Store identity may be exposed through image alt text, accessibility
  // labels, or metadata rather than ordinary text nodes. Include both text
  // nodes and quoted HTML attribute values in the normalized page evidence.
  const pageEvidence = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, tag =>
      " " + tag.replace(/(?:^|\s)[\w:-]+\s*=\s*(["'])(.*?)\1/g, " $2 ") + " "
    )
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  const storePattern = new RegExp(
    expected.store.replace(/\s+/g, "\\s+"),
    "i"
  );
  if (!storePattern.test(pageEvidence)) {
    const rawStoreIndex = html.toLowerCase().indexOf("metro");
    const evidenceStoreIndex = pageEvidence.toLowerCase().indexOf("metro");
    console.error("Store validation diagnostics:");
    console.error("HTML bytes: " + Buffer.byteLength(html, "utf8"));
    console.error("Raw HTML contains 'Metro': " + (rawStoreIndex >= 0));
    console.error("Normalized evidence contains 'Metro': " + (evidenceStoreIndex >= 0));
    if (rawStoreIndex >= 0) {
      console.error("Raw HTML context: " + html.slice(Math.max(0, rawStoreIndex - 180), rawStoreIndex + 260));
    }
    if (evidenceStoreIndex >= 0) {
      console.error("Normalized evidence context: " + pageEvidence.slice(Math.max(0, evidenceStoreIndex - 180), evidenceStoreIndex + 260));
    }
    console.error("HTML title: " + (html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i)?.[1] || "[missing]"));
  }
  assert.ok(
    storePattern.test(pageEvidence),
    "Expected store name is missing from product-page text and HTML attributes"
  );

  const images = extractSnippetImageUrls(html, productUrl);
  assert.ok(images.length, "No safe individual snippet image URL found on product page");
  console.log("Product metadata: " + expected.title + " | " + expected.store + " | " + expected.currentPrice + " EGP");
  console.log("Individual snippet images found: " + images.length);
  console.log("Image URL: " + images[0]);

  const image = await fetchCatalogImage(images[0], { timeoutMs: 30000 });
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
