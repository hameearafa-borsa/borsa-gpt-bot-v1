"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { escapeXml, renderPriceListImage, renderPriceListImages } = require("../modules/price-list-image");
const { extractPackageLabel } = require("../modules/price-list");
const imageSource = fs.readFileSync(path.join(__dirname, "../modules/price-list-image.js"), "utf8");
assert.match(imageSource, /require\("sharp"\)/, "image renderer must load sharp explicitly");
assert.match(imageSource, /Noto Sans Arabic,Noto Naskh Arabic,sans-serif/, "SVG must request installed Arabic-capable fonts before generic fallback");
const dockerSource = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
assert.match(dockerSource, /apk add --no-cache.*font-noto-arabic.*font-noto-naskh-arabic/, "production image must install dedicated Noto Arabic and Naskh Arabic font packages");
assert.match(dockerSource, /fc-match.*Noto Sans Arabic/, "production image build must verify the requested Noto Sans Arabic family is available");
assert.match(dockerSource, /fc-match.*Noto Naskh Arabic/, "production image build must verify the requested Noto Naskh Arabic family is available");
assert.match(imageSource, /\.png\(/, "image renderer must produce PNG output for Telegram");
assert.match(imageSource, /logoPlacement = "both"/, "combined group logo and watermark must be the default");
assert.match(imageSource, /id="securityTexture"/, "rendered pages must include a subtle security background");
assert.match(imageSource, /id="rowWatermark"/, "price rows must include a repeated light watermark");
assert.equal(escapeXml('<شركة & "A">'), '&lt;شركة &amp; &quot;A&quot;&gt;');
assert.equal(extractPackageLabel("اريال 50 جرام - 32 كيس - 134.6"), "32 كيس");
assert.equal(extractPackageLabel("بامبرز ماكسي مقاس 1 - 3 شنطة * 60 حفاضة - 912.56"), "3 شنطة × 60 حفاضة");
assert.equal(extractPackageLabel("ماكينة ناست حصائر 48 ماكينة - 48 قطعة - 406.56"), "48 قطعة");
(async () => {
  await assert.rejects(() => renderPriceListImage({ company: "شركة", items: [{ product: "أ", package_sale_price: 10 }] }), /three_valid_products/);
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
    const png = await renderPriceListImage({ company: "ﻗﺎﺋﻤﺔ اختبار", watermark: "بورصة المنظفات", items: [
      { product: "منتج أول", package_sale_price: 10 },
      { product: "منتج ثان", package_sale_price: 20 },
      { product: "منتج ثالث", package_sale_price: 30 },
      { product: "A".repeat(149) + "&end", package_sale_price: 40, volume_ml: 350, unit_price_type: "بالكرتونة", package_label: "350 مل · 32 كيس" }
    ] });
    assert.equal(png.toString(), "mock-png");
    assert.ok(capturedSvg.includes("قائمة اختبار"), "Arabic Presentation Forms in input must normalize to logical Unicode before SVG shaping");
    assert.ok(!capturedSvg.includes("ﻗﺎﺋﻤﺔ"), "Arabic Presentation Forms must not reach the SVG renderer");
    assert.ok(capturedSvg.includes("بورصة المنظفات"), "watermark must retain readable Arabic Unicode");
    assert.doesNotMatch(capturedSvg, /منتجات متنوعة/, "generic category labels must not be repeated above each product");
    assert.match(capturedSvg, /<tspan direction="auto" unicode-bidi="plaintext">/,
      "SVG must delegate Arabic shaping and mixed-direction layout to its text engine");
    assert.doesNotMatch(capturedSvg, /[\uFB50-\uFDFF\uFE70-\uFEFF]/,
      "renderer must not emit Arabic Presentation Forms that can become missing-glyph boxes");
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
    assert.ok(capturedSvg.includes("32 كيس"), "commercial package count should be rendered without flattening bags into pieces");
    // The image is a company-list view: render only package_sale_price.
    // Separate wholesale/consumer/list prices remain stored for comparison,
    // and must never silently replace or be mixed into the displayed list price.
    await renderPriceListImages({
      company: "قائمة متعددة الأسعار",
      items: [
        { product: "صنف بسعر قطعة", package_sale_price: 42.33, wholesale_carton_price: 346, consumer_price: 55, list_price: 60, unit_price_type: "بالقطعة", package_label: "32 كيس" },
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
    assert.equal(unileverLikeImages.length, 3,
      "66 products should render as three long-form images at the default 25 products per image");
    assert.ok(capturedSvg.includes("صفحة 3 من 3"),
      "the final image should identify itself as page 3 of 3");
    await assert.doesNotReject(() => renderPriceListImages({
      company: "شركة اختبار",
      items: Array.from({ length: 100 }, (_, i) => ({ product: `منتج ${i + 1}`, package_sale_price: 20 }))
    }), "exactly 100 valid products should be allowed");
    const largeCatalogImages = await renderPriceListImages({
      company: "شركة اختبار",
      items: Array.from({ length: 101 }, (_, i) => ({ product: `منتج ${i + 1}`, package_sale_price: 20 }))
    });
    assert.equal(largeCatalogImages.length, 5,
      "101 valid products should automatically render as five pages instead of failing at the former 100-product guard");
    assert.ok(capturedSvg.includes("صفحة 5 من 5"),
      "the final page of a catalog larger than 100 products must retain the correct page count");
  } finally { Module._load = originalLoad; }
  console.log("price list image validation tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
