"use strict";
const assert = require("node:assert/strict");
const { extractList } = require("../modules/price-list");
const text = `أسعار برسيل\nأوتوماتيك\nبرسيل 2 كيلو 100 جنيه\nبرسيل 3 كيلو 140 جنيه\nبرسيل 5 كيلو 220 جنيه`;
(async () => {
  let calls = 0;
  const result = await extractList({ generate: async () => { calls++; return { text: "{}" }; } }, text);
  assert.equal(calls, 0, "clean 3+ product list should be parsed locally without API usage");
  assert.equal(result.method, "deterministic");
  assert.ok(result.items.filter(x => x.decision === "accepted").length >= 3);
  console.log("price list deterministic-first tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
