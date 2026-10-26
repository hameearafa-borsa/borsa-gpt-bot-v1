"use strict";
const assert = require("node:assert/strict");
const { createGPTCore } = require("../core/gpt-core");

let calls = 0;
const core = createGPTCore({
  ai: { generate: async () => { calls += 1; return { text: "chemical" }; } },
  registry: {},
  diagnostics: () => {}
});

(async () => {
  const greeting = await core.classify("وعليكم السلام ورحمة الله وبركاته اخ العرب");
  assert.equal(greeting.type, "other");
  assert.equal(greeting.method, "rules");
  assert.equal(calls, 0, "common greetings must not consume an AI classification request");

  const result = await core.classify("ساعدني في فهم هذه الرسالة");
  assert.equal(result.type, "chemical");
  assert.equal(calls, 1, "unknown messages should still use AI classification");
  console.log("gpt core tests: OK");
})().catch((e) => { console.error(e); process.exit(1); });
