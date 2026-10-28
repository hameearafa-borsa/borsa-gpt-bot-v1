"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { escapeXml, renderPriceListImage } = require("../modules/price-list-image");
const imageSource = fs.readFileSync(path.join(__dirname, "../modules/price-list-image.js"), "utf8");
assert.match(imageSource, /require\("sharp"\)/, "image renderer must load sharp explicitly");
assert.match(imageSource, /Noto Sans Arabic,Noto Naskh Arabic,sans-serif/, "SVG must request installed Arabic-capable fonts before generic fallback");
const dockerSource = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
assert.match(dockerSource, /apk add --no-cache font-noto fontconfig/, "production image must install Arabic-capable fonts for SVG rasterization");
assert.match(imageSource, /\.png\(/, "image renderer must produce PNG output for Telegram");
assert.equal(escapeXml('<شركة & "A">'), '&lt;شركة &amp; &quot;A&quot;&gt;');
(async () => {
  await assert.rejects(() => renderPriceListImage({ company: "شركة", items: [{ product: "أ", package_sale_price: 10 }] }), /three_valid_products/);
  await assert.rejects(() => renderPriceListImage({ company: "شركة", items: Array.from({length: 101}, (_, i) => ({ product: `منتج ${i}`, package_sale_price: 10 })) }), /exceeds_100_products/);
  const originalLoad = Module._load;
  let capturedSvg = "";
  try {
    Module._load = function(request, parent, isMain) {
      if (request === "sharp") return input => {
        capturedSvg = Buffer.from(input).toString("utf8");
        return { png: options => ({ toBuffer: async () => Buffer.from("mock-png") }) };
      };
      return originalLoad.call(this, request, parent, isMain);
    };
    const png = await renderPriceListImage({ company: "شركة اختبار", watermark: "بورصة المنظفات", items: [
      { product: "منتج أول", package_sale_price: 10 },
      { product: "منتج ثان", package_sale_price: 20 },
      { product: "منتج ثالث", package_sale_price: 30 },
      { product: "A".repeat(149) + "&end", package_sale_price: 40, unit_price_type: "بالكرتونة" }
    ] });
    assert.equal(png.toString(), "mock-png");
    assert.match(capturedSvg, /شركة اختبار/);
    assert.match(capturedSvg, /بورصة المنظفات/);
    assert.ok(capturedSvg.includes("A".repeat(149) + "&amp;"), "truncate original product name before XML escaping");
    assert.ok(!capturedSvg.includes("A".repeat(149) + "&end"), "raw ampersands must never leak into SVG text");
    assert.match(capturedSvg, /10 ج\.م/);
    assert.match(capturedSvg, /بالكرتونة/, "carton price type should be visible on rendered list rows");
  } finally { Module._load = originalLoad; }
  console.log("price list image validation tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
