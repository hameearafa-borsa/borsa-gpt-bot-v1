"use strict";
const assert = require("node:assert/strict");
const chemical = require("../modules/chemical-assistant");

(async () => {
  const errors = [];
  const failingAI = {
    async generate() {
      const error = new Error("AI HTTP 503: temporary provider failure");
      error.status = 503;
      throw error;
    }
  };
  const fallback = await chemical.answer(failingAI, "عايز تركيبة صابون سائل", error => errors.push(error));
  assert.equal(fallback, chemical.SAFE_FALLBACK, "provider failure should return the safe temporary-unavailability message");
  assert.match(fallback, /مشغول أو غير متاح مؤقتًا/);
  assert.equal(errors.length, 1, "provider failure should invoke diagnostics exactly once");
  assert.match(errors[0].message, /503/);

  const openaiCalls = [];
  const openaiAnswer = await chemical.answer({
    async generate(prompt, options) {
      openaiCalls.push({ prompt, options });
      assert.match(prompt, /أسماء الخامات المتداولة في السوق المصري/);
      assert.equal(options.temperature, 0.3);
      assert.equal(options.timeoutMs, 120000);
      return { text: "تركيبة مبدئية عملية", provider: "openai" };
    }
  }, "عايز تركيبة جيل غسيل ملابس");
  assert.equal(openaiCalls.length, 1);
  assert.match(openaiAnswer, /تقنيات OpenAI/);
  assert.match(openaiAnswer, /تركيبة مبدئية عملية/);

  const missingErrors = [];
  const missingFallback = await chemical.answer(null, "عايز تركيبة صابون سائل", error => missingErrors.push(error));
  assert.equal(missingFallback, chemical.SAFE_FALLBACK);
  assert.equal(missingErrors.length, 1, "missing provider should be diagnosable");

  const safetyErrors = [];
  const warning = await chemical.answer(failingAI, "هل أخلط الكلور مع حمض الفلاش؟", error => safetyErrors.push(error));
  assert.match(warning, /لا تخلط/);
  assert.equal(safetyErrors.length, 0, "safety gate should not call provider or report a provider failure");

  console.log("chemical answer failure and OpenAI response tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
