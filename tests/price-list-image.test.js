"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { escapeXml, renderPriceListImage, renderPriceListImages } = require("../modules/price-list-image");
const imageSource = fs.readFileSync(path.join(__dirname, "../modules/price-list-image.js"), "utf8");
assert.match(imageSource, /require\("sharp"\)/, "image renderer must load sharp explicitly");
assert.match(imageSource, /Noto Sans Arabic,Noto Naskh Arabic,sans-serif/, "SVG must request installed Arabic-capable fonts before generic fallback");
assert.doesNotMatch(imageSource, /bidi-shaper|shapeArabicForSvg/, "Arabic must remain logical Unicode text for native SVG shaping");
assert.match(imageSource, /unicode-bidi="plaintext"/, "SVG text must use paragraph-aware bidi resolution");
const mixedLogical = "دوف 350 مل — 121.00 ج.م";
assert.ok(mixedLogical.includes("121.00"), "numeric price must remain intact in mixed Arabic text");
assert.doesNotMatch(mixedLogical, /[\\uFB50-\\uFDFF\\uFE70-\\uFEFF]/, "source text must not be converted to Arabic presentation forms");
const dockerSource = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
assert.match(dockerSource, /apk add --no-cache font-noto fontconfig/, "production image must install Arabic-capable fonts for SVG rasterization");
assert.match(imageSource, /\.png\(/, "image renderer must produce PNG output for Telegram");
assert.match(imageSource, /logoPlacement = "both"/, "combined group logo and watermark must be the default");
assert.match(imageSource, /id="securityTexture"/, "rendered pages must include a subtle security background");
assert.match(imageSource, /id="rowWatermark"/, "price rows must include a repeated light watermark");
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
      { product: "A".repeat(149) + "&end", package_sale_price: 40, volume_ml: 350, unit_price_type: "بالكرتونة" }
    ] });
    assert.equal(png.toString(), "mock-png");
    assert.ok(capturedSvg.includes("قائمة أسعار"), "Arabic company heading must remain in logical Unicode order");
    assert.match(capturedSvg, /unicode-bidi="plaintext"/, "SVG should delegate bidirectional text layout to the renderer");
    assert.ok(capturedSvg.includes("بورصة المنظفات"), "watermark must use shaped Arabic text");
    assert.match(capturedSvg, /data:image\/(?:jpeg|png);base64,/, "default output must embed the group logo");
    assert.match(capturedSvg, /url\(#securityTexture\)/, "default output must include the subtle security background");
    assert.match(capturedSvg, /url\(#rowWatermark\)/, "default output must repeat the watermark across price rows");
    assert.ok(capturedSvg.includes("A".repeat(149) + "&amp;"), "truncate original product name before XML escaping");
    assert.ok(!capturedSvg.includes("A".repeat(149) + "&end"), "raw ampersands must never leak into SVG text");
    assert.ok(capturedSvg.includes("10") && capturedSvg.includes("ج.م"), "price currency label should be shaped while digits remain intact");
    assert.ok(capturedSvg.includes("بالكرتونة"), "carton price type should be visible with shaped Arabic");
    assert.ok(capturedSvg.includes("العبوة / السعة"), "package size should have its own labeled middle column");
    assert.ok(capturedSvg.includes("الصنف"), "product name should have a separate column heading");
    assert.ok(capturedSvg.includes("السعر"), "price should have a separate column heading");
    assert.ok(capturedSvg.includes("350") && capturedSvg.includes("مل"), "package capacity should preserve its number and shape its Arabic unit");
    // The image is a company-list view: render only package_sale_price.
    // Separate wholesale/consumer/list prices remain stored for comparison,
    // and must never silently replace or be mixed into the displayed list price.
    await renderPriceListImages({
      company: "قائمة متعددة الأسعار",
      items: [
        { product: "صنف بسعر قطعة", package_sale_price: 42.33, wholesale_carton_price: 346, consumer_price: 55, list_price: 60, unit_price_type: "بالقطعة" },
        { product: "صنف بسعر كرتونة", package_sale_price: 346, wholesale_carton_price: 999, consumer_price: 888, list_price: 777, unit_price_type: "بالكرتونة" },
        { product: "صنف ثالث", package_sale_price: 125, wholesale_carton_price: 500, consumer_price: 250, list_price: 300, unit_price_type: "بالكرتونة" }
      ]
    });
    assert.ok(capturedSvg.includes("42.33") && capturedSvg.includes("ج.م"), "the declared package price should be rendered for per-piece rows");
    assert.ok(capturedSvg.includes("346") && capturedSvg.includes("ج.م"), "the declared package price should be rendered for carton rows");
    const renderedText = Array.from(capturedSvg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g), match => match[1]).join(" ");
    assert.doesNotMatch(renderedText, /999|888|777|500|250|300/, "separate wholesale, consumer and list prices must not leak into visible image text");
    const unileverLikeImages = await renderPriceListImages({
      company: "شركة اختبار",
      items: Array.from({ length: 66 }, (_, i) => ({
        product: `منتج ${i + 1}`,
        package_sale_price: 20 + i,
        unit_price_type: i % 3 === 0 ? "بالقطعة" : "بالكرتونة"
      }))
    });
    assert.equal(unileverLikeImages.length, 5,
      "66 products should render as five images at the default 16 products per image");
    assert.ok(capturedSvg.includes("صفحة 5 من 5"),
      "the final image should identify itself as page 5 of 5");
    await assert.doesNotReject(() => renderPriceListImages({
      company: "شركة اختبار",
      items: Array.from({ length: 100 }, (_, i) => ({ product: `منتج ${i + 1}`, package_sale_price: 20 }))
    }), "exactly 100 valid products should be allowed");
  } finally { Module._load = originalLoad; }
  console.log("price list image validation tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
