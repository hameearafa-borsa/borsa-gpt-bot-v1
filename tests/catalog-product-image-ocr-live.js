"use strict";

const assert = require("node:assert/strict");
const sharp = require("sharp");
const { safeCatalogPageImageUrl, fetchCatalogImage } = require("../modules/catalog-page-ocr");
const { createImageOcr } = require("../modules/image-ocr");

const products = [
  {
    id: "191790",
    url: "https://snapflyer.io/eg/downtown/products/191790",
    title: "Metro Tissues 400 Sheets x 3 Packs",
    currentPrice: "74.99",
    store: "Metro Market",
    pageNumber: 4,
    identityTerms: ["مناديل", "مترو"],
    minIdentityMatches: 2
  },
  {
    id: "191822",
    url: "https://snapflyer.io/eg/downtown/products/191822",
    title: "Oxi Dishwashing Liquid 2.5L",
    currentPrice: "114.95",
    store: "Metro Market",
    pageNumber: 8,
    identityTerms: ["oxi"],
    minIdentityMatches: 1
  }
];
const MAX_HTML_BYTES = 2_000_000;
const STORE_CATALOG_PATH = "/metro-market/2026-10/flyer_1325/snippets/";

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

function normalizeOcrText(value) {
  return String(value || "")
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[٬،]/g, ",")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function recognizeProductIdentity(image, product) {
  const cropAndEnlarge = async input => {
    const source = sharp(input, { limitInputPixels: 40000000 });
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height) throw new Error("ocr_image_dimensions_unavailable");
    // Isolate the product area below the price banner and enlarge its brand mark.
    const left = Math.floor(metadata.width * 0.18);
    const top = Math.floor(metadata.height * 0.24);
    const width = Math.max(1, Math.floor(metadata.width * 0.68));
    const height = Math.max(1, Math.floor(metadata.height * 0.70));
    return source.extract({
      left,
      top,
      width: Math.min(width, metadata.width - left),
      height: Math.min(height, metadata.height - top)
    }).resize({ width: 1200 }).grayscale().normalize().sharpen().png().toBuffer();
  };

  for (const psm of ["11", "6"]) {
    const retryOcr = createImageOcr({
      timeoutMs: 60000,
      pageSegmentationMode: psm,
      preprocess: cropAndEnlarge
    });
    const retry = await retryOcr.extract(image, {
      storeKey: "metro_market",
      catalogUrl: product.url,
      fingerprint: "snapflyer-product-" + product.id + "-identity-retry",
      pageNumber: product.pageNumber,
      productId: product.id
    });
    console.log("--- Cropped/enlarged OCR (PSM " + psm + ") ---");
    console.log(retry.text || "[NO TEXT RECOGNIZED]");
    const normalized = normalizeOcrText(retry.text);
    const matches = product.identityTerms.filter(term =>
      normalized.includes(term.toLowerCase())
    );
    if (matches.length >= product.minIdentityMatches) {
      return { matches, psm };
    }
  }
  return null;
}

async function verifyProduct(product, ocr) {
  console.log("\n=== " + product.id + " | " + product.title + " ===");
  console.log("Product page: " + product.url);

  const html = await fetchProductPage(product.url);
  assert.ok(html.includes(product.title), "Expected product title is missing: " + product.title);
  assert.ok(html.includes(product.currentPrice), "Expected current price is missing: " + product.currentPrice);

  const images = extractSnippetImageUrls(html, product.url);
  assert.ok(images.length, "No safe individual snippet image URL found for " + product.id);
  const storeImage = images.find(url =>
    new URL(url).pathname.toLowerCase().includes(STORE_CATALOG_PATH)
  );
  assert.ok(
    storeImage,
    "No product-page snippet image tied to Metro Market catalog 1325 for " + product.id
  );

  console.log("Product metadata: " + product.store + " | " + product.currentPrice + " EGP");
  console.log("Individual snippet images found: " + images.length);
  console.log("Validated store/catalog image: " + storeImage);

  const image = await fetchCatalogImage(storeImage, { timeoutMs: 30000 });
  const result = await ocr.extract(image, {
    storeKey: "metro_market",
    catalogUrl: product.url,
    fingerprint: "snapflyer-product-" + product.id,
    pageNumber: product.pageNumber,
    productId: product.id
  });

  console.log("--- OCR text ---");
  console.log(result.text || "[NO TEXT RECOGNIZED]");
  console.log("OCR characters: " + result.characterCount);
  assert.ok(result.hasText, "OCR returned no text for product " + product.id);

  const normalizedOcr = normalizeOcrText(result.text);
  const normalizedPrice = product.currentPrice.replace(/,/g, ".").toLowerCase();
  assert.ok(
    normalizedOcr.includes(normalizedPrice),
    "OCR text does not contain expected current price " + product.currentPrice +
      " for product " + product.id
  );

  let matchedIdentityTerms = product.identityTerms.filter(term =>
    normalizedOcr.includes(term.toLowerCase())
  );
  let identityMethod = "original snippet OCR";
  if (matchedIdentityTerms.length < product.minIdentityMatches) {
    const retry = await recognizeProductIdentity(image, product);
    assert.ok(
      retry,
      "OCR could not verify product identity after cropped/enlarged retries for " + product.id
    );
    matchedIdentityTerms = retry.matches;
    identityMethod = "cropped/enlarged OCR PSM " + retry.psm;
  }

  console.log("OCR price match: " + normalizedPrice + " EGP");
  console.log("OCR identity matches: " + matchedIdentityTerms.join(", "));
  console.log("Identity verification method: " + identityMethod);
  console.log("PRODUCT OCR VERIFIED: " + product.id);
}

(async () => {
  console.log("Live SnapFlyer individual-product image OCR experiment");
  const ocr = createImageOcr({ timeoutMs: 60000, pageSegmentationMode: "6" });

  for (const product of products) {
    await verifyProduct(product, ocr);
  }

  console.log("\nLIVE SNAPFLYER MULTI-PRODUCT OCR: OK (" + products.length +
    " Metro Market products verified)");
})().catch(error => {
  console.error("LIVE SNAPFLYER MULTI-PRODUCT OCR: FAILED");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
