"use strict";
const assert = require("node:assert/strict");
const { createGPTCore } = require("../core/gpt-core");
const { loadRegistry } = require("../core/product-registry");
const registry = loadRegistry();

let calls = 0;

const core = createGPTCore({
  ai: {
    generate: async () => {
      calls += 1;
      return { text: "chemical" };
    }
  },
  registry,
  diagnostics: () => {}
});

(async () => {
  const greeting = await core.classify(
    "وعليكم السلام ورحمة الله وبركاته اخ العرب"
  );
  assert.equal(greeting.type, "other");
  assert.equal(greeting.method, "rules");
  assert.equal(calls, 0);

  const general = await core.classify("ساعدني في فهم هذه الرسالة");
  assert.equal(general.type, "other");
  assert.equal(general.method, "rules");
  assert.equal(calls, 0);

  const clearPrice = await core.classify("مسحوق تايد سعره ١٢٠ جنيه");
  assert.equal(clearPrice.type, "price_observation");
  assert.equal(clearPrice.method, "rules");
  assert.equal(calls, 0);

  const ambiguousPrice = await core.classify("العبوة دي بـ ١٢٠");
  assert.equal(ambiguousPrice.method, "ai");
  assert.equal(calls, 1);

  const colloquialPrice = await core.classify("ده بكام؟");
  assert.equal(colloquialPrice.method, "ai");
  assert.equal(calls, 2);

  const spacedPrice = await core.classify("ده ب ١٢٠");
  assert.equal(spacedPrice.method, "ai");
  assert.equal(calls, 3);

  const generalMessage = await core.classify("صباح الخير يا جماعة");
  assert.notEqual(generalMessage.method, "ai");
  assert.equal(calls, 3);

  const bonuxPrice = await core.classify("بونكس 2 كجم 120");
  assert.equal(bonuxPrice.type, "price_observation");
  assert.equal(bonuxPrice.method, "rules");
  assert.equal(calls, 3);

  const jawyPrice = await core.classify("جوي 1 لتر 40");
  assert.equal(jawyPrice.type, "price_observation");
  assert.equal(jawyPrice.method, "rules");
  assert.equal(calls, 3);

  const plainBrandMention = await core.classify("جوي موجود؟");
  assert.equal(plainBrandMention.type, "other");
  assert.equal(plainBrandMention.method, "rules");
  assert.equal(calls, 3);

  const failingCore = createGPTCore({
    ai: {
      generate: async () => {
        throw new Error("simulated provider failure");
      }
    },
    registry: {},
    diagnostics: () => {}
  });

  const fallback = await failingCore.classify("العبوة دي بـ ١٢٠");
  assert.equal(fallback.type, "other");
  assert.equal(fallback.method, "fallback");

  console.log("gpt core tests: OK");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
