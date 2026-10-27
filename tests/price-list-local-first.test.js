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

  const fallbackText = `أسعار شركة برسيل
برسيل 2 كيلو 100 جنيه
برسيل 3 كيلو 140 جنيه`;
  const empty = await extractList({ generate: async () => ({ text: JSON.stringify({ company: "شركة برسيل", items: [] }) }) }, fallbackText);
  assert.equal(empty.method, "fallback", "empty AI arrays must fall back to local parsing");
  assert.ok(empty.items.length >= 2, "empty AI arrays must not discard locally parseable rows");

  const unusable = await extractList({ generate: async () => ({ text: JSON.stringify({ items: [{ product: "", package_sale_price: null, decision: "accepted" }] }) }) }, fallbackText);
  assert.equal(unusable.method, "fallback", "AI output with no usable rows must fall back locally");
  assert.ok(unusable.items.length >= 2, "unusable AI output must preserve locally parseable rows");
  console.log("price list deterministic-first and empty-AI fallback tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
