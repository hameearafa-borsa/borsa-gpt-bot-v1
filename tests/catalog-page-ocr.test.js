"use strict";
const assert = require("node:assert/strict");
const { safeCatalogPageImageUrl, extractCatalogPageImages, scanCatalogPageImages, persistCatalogOcrPages } = require("../modules/catalog-page-ocr");

const base = "https://snapflyer.io/eg/downtown/offers/metro-market/1489";
assert.equal(safeCatalogPageImageUrl("/storage/flyers/eg/metro-market/2026-10/flyer_1489/pages/page_2.webp", base),
  "https://snapflyer.io/storage/flyers/eg/metro-market/2026-10/flyer_1489/pages/page_2.webp");
assert.equal(safeCatalogPageImageUrl("https://evil.example/page_2.webp", base), null);
assert.equal(safeCatalogPageImageUrl("https://snapflyer.io/other/page_2.webp", base), null);
assert.equal(safeCatalogPageImageUrl("http://snapflyer.io/storage/flyers/a/page_2.webp", base), null);
const html = '<img src="/storage/flyers/eg/metro-market/2026-10/flyer_1489/pages/page_2.webp"><img data-src="/storage/flyers/eg/metro-market/2026-10/flyer_1489/pages/page_1.webp"><img src="https://evil.example/page_3.webp">';
const images = extractCatalogPageImages(html, base);
assert.deepEqual(images.map(x => x.pageNumber), [1, 2]);
(async () => {
  const fetched = [];
  const ocr = { extract: async (buffer, metadata) => {
    fetched.push({ buffer: buffer.toString(), metadata });
    return { text: "شاي تتلي 49.99 جنيه", hasText: true, characterCount: 20, engine: "tesseract" };
  } };
  const scan = await scanCatalogPageImages({
    html, catalogUrl: base, storeKey: "metro_market", fingerprint: "fp-1489",
    fetchImage: async url => Buffer.from(url.endsWith("page_1.webp") ? "page-one" : "page-two"),
    ocr
  });
  assert.equal(scan.pageCount, 2);
  assert.deepEqual(scan.pages.map(p => p.pageNumber), [1, 2]);
  assert.ok(scan.pages.every(p => p.storeKey === "metro_market" && p.fingerprint === "fp-1489" && p.status === "extracted"));
  assert.equal(fetched.length, 2);
  const empty = await scanCatalogPageImages({
    html: '<img src="/storage/flyers/eg/metro-market/2026-10/flyer_1489/pages/page_1.webp">',
    catalogUrl: base, storeKey: "metro_market", fingerprint: "fp-empty",
    fetchImage: async () => Buffer.from("x"),
    ocr: { extract: async () => ({ text: "", hasText: false, characterCount: 0 }) }
  });
  assert.equal(empty.pages[0].status, "empty");
  const failed = await scanCatalogPageImages({
    html: '<img src="/storage/flyers/eg/metro-market/2026-10/flyer_1489/pages/page_1.webp">',
    catalogUrl: base, storeKey: "metro_market", fingerprint: "fp-failed",
    fetchImage: async () => { throw new Error("network_down"); }, ocr
  });
  assert.equal(failed.pages[0].status, "failed");
  assert.match(failed.pages[0].error, /network_down/);
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; } };
  const persisted = await persistCatalogOcrPages(pool, scan);
  assert.deepEqual(persisted, { inserted: 2, unchanged: 0, pageCount: 2 });
  assert.match(calls[0].sql, /ON CONFLICT\(store_key,catalog_url,fingerprint,page_number\)/);
  assert.equal(calls[0].params[0], "metro_market");
  assert.equal(calls[0].params[2], "fp-1489");
  assert.equal(calls[0].params[5], "شاي تتلي 49.99 جنيه");
  console.log("catalog page OCR tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
