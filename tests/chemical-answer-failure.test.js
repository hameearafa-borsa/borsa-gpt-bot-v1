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
