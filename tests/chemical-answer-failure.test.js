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
  const unavailable = await chemical.answer(
    failingAI,
    "عايز تركيبة صابون سائل",
    error => errors.push(error)
  );
  assert.match(unavailable, /مشغولة أو غير متاحة مؤقتًا/);
  assert.equal(errors.length, 1, "provider failure should invoke diagnostics exactly once");
  assert.match(errors[0].message, /503/);

  const primaryOptions = [];
  const primaryAI = {
    async generate(prompt, options) {
      primaryOptions.push({ prompt, options });
      assert.match(prompt, /أسماء الخامات المتداولة في سوق المنظفات المصري/);
      assert.equal(options.webSearch, false);
      assert.equal(options.timeoutMs, 3500);
      assert.equal(options.requestBudgetMs, 14000);
      return { text: "تركيبة عملية مناسبة لصاحب المحل", provider: "openai" };
    }
  };
  const recovered = await chemical.answer(
    primaryAI,
    "مطلوب تركيبة جيل سائل لغسيل الملابس ذات جودة عالية"
  );
  assert.match(recovered, /تقنيات OpenAI/);
  assert.match(recovered, /تركيبة عملية مناسبة لصاحب المحل/);
  assert.equal(primaryOptions.length, 1);

  const missingErrors = [];
  const missingConfig = await chemical.answer(
    null,
    "عايز تركيبة صابون سائل",
    error => missingErrors.push(error)
  );
  assert.equal(missingConfig, chemical.SERVICE_CONFIG_FALLBACK);
  assert.equal(missingErrors.length, 1, "missing provider configuration should be diagnosable");

  const safetyErrors = [];
  const warning = await chemical.answer(
    failingAI,
    "هل أخلط الكلور مع حمض الفلاش؟",
    error => safetyErrors.push(error)
  );
  assert.match(warning, /لا تخلط/);
  assert.equal(safetyErrors.length, 0, "safety gate must stop before making a provider request");

  console.log("chemical answer failure diagnostics tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
