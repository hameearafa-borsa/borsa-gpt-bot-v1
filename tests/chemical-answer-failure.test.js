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
  assert.equal(fallback, chemical.SAFE_FALLBACK, "provider failure should return the safe fallback");
  assert.equal(errors.length, 1, "provider failure should invoke the diagnostics callback exactly once");
  assert.match(errors[0].message, /503/);

  const fallbackOptions = [];
  const fallbackAI = {
    async generate(prompt, options) {
      fallbackOptions.push({ prompt, options });
      return { text: "إجابة احتياطية عملية", provider: "openai" };
    }
  };
  const recovered = await chemical.answer(failingAI, "مطلوب تركيبة جيل سائل لغسيل الملابس ذات جودة عالية", error => errors.push(error), fallbackAI);
  assert.match(recovered, /إجابة احتياطية عملية/, "OpenAI should rescue the answer when Gemini is temporarily unavailable");
  assert.match(recovered, /OpenAI/, "the fallback provider should be identified");
  assert.equal(fallbackOptions.length, 1, "the OpenAI fallback should be called exactly once");
  assert.equal(fallbackOptions[0].options.webSearch, false, "web search must not be mandatory on the rescue path");
  assert.equal(fallbackOptions[0].options.timeoutMs, 3500, "each fallback key receives a short bounded timeout");
  assert.equal(fallbackOptions[0].options.requestBudgetMs, 14000, "all fallback keys and providers share a bounded 14-second budget");

  const missingErrors = [];
  const missingFallback = await chemical.answer(null, "عايز تركيبة صابون سائل", error => missingErrors.push(error));
  assert.equal(missingFallback, chemical.SAFE_FALLBACK);
  assert.equal(missingErrors.length, 1, "missing provider should be diagnosable");

  const safetyErrors = [];
  const warning = await chemical.answer(failingAI, "هل أخلط الكلور مع حمض الفلاش؟", error => safetyErrors.push(error));
  assert.match(warning, /لا تخلط/);
  assert.equal(safetyErrors.length, 0, "safety gate should not call Gemini or report a provider failure");

  console.log("chemical answer failure diagnostics tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
