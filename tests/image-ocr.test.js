"use strict";
const assert = require("node:assert/strict");
const {
  createImageOcr,
  normalizeOcrText,
  MAX_IMAGE_BYTES,
  recognizeWithTesseract
} = require("../modules/image-ocr");

(async () => {
  assert.equal(normalizeOcrText("  أريال\r\n  ١٢٥ ج  \n\n\nبرسيل "), "أريال\n  ١٢٥ ج\n\nبرسيل");
  assert.equal(normalizeOcrText("السعر\u200f ١٠٠"), "السعر ١٠٠");
  assert.equal(normalizeOcrText("   "), "");
  assert.throws(() => recognizeWithTesseract(Buffer.from("x"), { pageSegmentationMode: "99" }), /ocr_invalid_page_segmentation_mode/);

  let prepared = 0, recognized = 0;
  const ocr = createImageOcr({
    preprocess: async input => { prepared++; assert.equal(input.toString(), "image"); return Buffer.from("prepared"); },
    recognize: async input => { recognized++; assert.equal(input.toString(), "prepared"); return "أريال ٢ ك ١٢٥ ج\nبرسيل ٢.٥ لتر ١٩٠ ج"; }
  });
  const result = await ocr.extract(Buffer.from("image"));
  assert.equal(prepared, 1);
  assert.equal(recognized, 1);
  assert.equal(result.hasText, true);
  assert.equal(result.characterCount, result.text.length);
  assert.match(result.text, /أريال ٢ ك ١٢٥ ج/);
  assert.equal(result.engine, "tesseract");

  await assert.rejects(() => ocr.extract("not a buffer"), /ocr_image_buffer_required/);
  await assert.rejects(() => ocr.extract(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /ocr_image_too_large/);
  const empty = createImageOcr({ preprocess: async x => x, recognize: async () => "  " });
  assert.equal((await empty.extract(Buffer.from("x"))).hasText, false);

  console.log("image OCR service tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
