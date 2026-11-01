"use strict";

const { createImageOcr, MAX_IMAGE_BYTES } = require("./image-ocr");

const MAX_CATALOG_PAGES = 60;
const MAX_CATALOG_HTML_BYTES = 2_000_000;
const IMAGE_HOST = "snapflyer.io";

function safeCatalogPageImageUrl(raw, baseUrl) {
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== "https:" || url.hostname !== IMAGE_HOST || url.username || url.password ||
        (url.port && url.port !== "443") || !/^\/storage\/flyers\/[a-z0-9/_-]+\.(?:webp|png|jpe?g)$/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function extractCatalogPageImages(html, catalogUrl) {
  if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > MAX_CATALOG_HTML_BYTES) return [];
  const urls = new Set();
  const attrPattern = /(?:src|data-src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrPattern)) {
    const safe = safeCatalogPageImageUrl(match[1], catalogUrl);
    if (safe) urls.add(safe);
  }
  return [...urls].map(url => {
    const match = new URL(url).pathname.match(/(?:page|pages)[_-]?(\d+)\.(?:webp|png|jpe?g)$/i);
    return { url, pageNumber: match ? Number(match[1]) : null };
  }).sort((a, b) => (a.pageNumber ?? Number.MAX_SAFE_INTEGER) - (b.pageNumber ?? Number.MAX_SAFE_INTEGER))
    .slice(0, MAX_CATALOG_PAGES);
}

async function fetchCatalogImage(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const safe = safeCatalogPageImageUrl(url, url);
  if (!safe) throw new Error("catalog_image_url_not_allowed");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(safe, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "image/avif,image/webp,image/png,image/jpeg" } });
    if (!response.ok) throw new Error("catalog_image_http_" + response.status);
    const type = response.headers?.get?.("content-type") || "";
    if (type && !/^image\/(?:webp|png|jpeg)(?:;|$)/i.test(type)) throw new Error("catalog_image_unexpected_content_type");
    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (declared > maxBytes) throw new Error("catalog_image_too_large");
    if (!response.body || typeof response.body.getReader !== "function") {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > maxBytes) throw new Error("catalog_image_too_large_or_empty");
      return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error("catalog_image_too_large");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    if (!total) throw new Error("catalog_image_too_large_or_empty");
    return Buffer.concat(chunks, total);
  } finally { clearTimeout(timer); }
}

async function scanCatalogPageImages({ html, catalogUrl, storeKey, fingerprint, fetchImage = fetchCatalogImage, ocr = createImageOcr(), maxPages = MAX_CATALOG_PAGES }) {
  if (!["bim", "kazyon", "metro_market"].includes(storeKey)) throw new TypeError("unsupported_catalog_store");
  if (!catalogUrl || !fingerprint) throw new TypeError("catalog_provenance_required");
  const images = extractCatalogPageImages(html, catalogUrl).slice(0, Math.max(1, Math.min(MAX_CATALOG_PAGES, Number(maxPages) || MAX_CATALOG_PAGES)));
  const pages = [];
  for (const image of images) {
    const pageNumber = image.pageNumber ?? pages.length + 1;
    try {
      const buffer = await fetchImage(image.url, { maxBytes: MAX_IMAGE_BYTES });
      const result = await ocr.extract(buffer, { storeKey, catalogUrl, fingerprint, pageNumber });
      pages.push({
        storeKey, catalogUrl, fingerprint, pageNumber, imageUrl: image.url,
        text: result.text, hasText: result.hasText, characterCount: result.characterCount,
        engine: result.engine || "tesseract", status: result.hasText ? "extracted" : "empty", error: null
      });
    } catch (error) {
      pages.push({
        storeKey, catalogUrl, fingerprint, pageNumber, imageUrl: image.url,
        text: "", hasText: false, characterCount: 0, engine: "tesseract",
        status: "failed", error: String(error?.message || error).slice(0, 300)
      });
    }
  }
  return { storeKey, catalogUrl, fingerprint, pageCount: images.length, pages };
}

async function persistCatalogOcrPages(pool, scan) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("catalog OCR persistence requires a database pool");
  if (!scan || !["bim", "kazyon", "metro_market"].includes(scan.storeKey) || !scan.catalogUrl || !scan.fingerprint || !Array.isArray(scan.pages)) {
    throw new TypeError("invalid catalog OCR scan");
  }
  let inserted = 0, unchanged = 0;
  for (const page of scan.pages) {
    const result = await pool.query(
      "INSERT INTO catalog_ocr_pages(store_key,catalog_url,fingerprint,page_number,image_url,ocr_text,character_count,engine,status,last_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(store_key,catalog_url,fingerprint,page_number) DO UPDATE SET image_url=EXCLUDED.image_url,ocr_text=EXCLUDED.ocr_text,character_count=EXCLUDED.character_count,engine=EXCLUDED.engine,status=EXCLUDED.status,last_error=EXCLUDED.last_error,updated_at=NOW() WHERE catalog_ocr_pages.status <> 'extracted' RETURNING page_number",
      [page.storeKey, page.catalogUrl, page.fingerprint, page.pageNumber, page.imageUrl, page.text, page.characterCount, page.engine, page.status, page.error]
    );
    if (result.rowCount) inserted++;
    else unchanged++;
  }
  return { inserted, unchanged, pageCount: scan.pageCount };
}

module.exports = { MAX_CATALOG_PAGES, safeCatalogPageImageUrl, extractCatalogPageImages, fetchCatalogImage, scanCatalogPageImages, persistCatalogOcrPages };
