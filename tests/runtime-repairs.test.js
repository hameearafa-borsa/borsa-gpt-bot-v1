"use strict";
const assert = require("node:assert/strict");
const { safetyGate } = require("../modules/chemical-assistant");
const { responsesBody, xaiResponsesBody, textFromResponses, samplingAllowed } = require("../core/ai");
const { cairoLocalToUtc } = require("../modules/scheduler");
const { priceAppears, extractList } = require("../modules/price-list");
const { observe } = require("../modules/price-monitor");
const { extractCards } = require("../modules/deal-sources");
const { buildPoolConfig, splitSql, stripSslParams, close } = require("../core/database");
const registry = require("../data/product-registry.json");

assert.equal(safetyGate("هل يجوز خلط الكلور مع المطهر؟"), null);
assert.match(safetyGate("هل أخلط الكلور مع حمض؟"), /تحذير سلامة/);
assert.match(safetyGate("استخدام الكلور مع الخل"), /تحذير سلامة/);
assert.match(safetyGate("الكلور مع الأمونيا"), /تحذير سلامة/);

const luna = responsesBody("gpt-6-luna", "صنف النص", { temperature: 0 });
assert.equal(Object.hasOwn(luna, "temperature"), false);
assert.equal(luna.reasoning.effort, "low");
assert.equal(samplingAllowed("gpt-6-luna"), false);
assert.equal(samplingAllowed("grok-4.7"), false);
const grok = xaiResponsesBody("grok-4.7", "صنف النص", { temperature: 0 });
assert.equal(Object.hasOwn(grok, "temperature"), false);
assert.equal(grok.model, "grok-4.7");
assert.equal(textFromResponses({ output: [{ type: "reasoning", content: [] }, { type: "message", content: [{ type: "output_text", text: "price_observation" }] }] }), "price_observation");

const cairo = cairoLocalToUtc("2026-07-13T17:00");
const deltaHours = (Date.UTC(2026, 6, 13, 17, 0, 0) - cairo.getTime()) / 3600000;
assert.ok(deltaHours === 2 || deltaHours === 3, `Cairo offset should be +2 or +3, got ${deltaHours}`);

assert.equal(priceAppears("السعر 505.31 جنيه", 505.31), true);
assert.equal(priceAppears("السعر 505.31 جنيه", 99999), false);

(async () => {
  const guarded = await extractList({
    generate: async () => ({ text: JSON.stringify({ company: "وهم", items: [{ product: "منتج مخترع", package_sale_price: 99999, decision: "accepted" }] }), provider: "test" })
  }, "أسعار بيرل\nاوتوماتيك\n• 9 ك: 505.31 | جملة 487.40 | مستهلك 525\n• 5 ك: 308.43 | جملة 915.87 | مستهلك 325\n• 2.5 ك: 179.15 | جملة 716.63 | مستهلك 200\n• 2 ك: 129.22 | جملة 516.90 | مستهلك 145\n• 1 ك: 66.28 | جملة 265.15 | مستهلك 75");
  assert.equal(guarded.method, "deterministic_guard");
  assert.ok(guarded.items.some((item) => item.package_sale_price === 505.31));

  const calls = [];
  const pool = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes("INSERT INTO products")) return { rows: [{ id: 3 }] };
      if (sql.includes("SELECT id FROM product_variants")) return { rows: [] };
      if (sql.includes("INSERT INTO product_variants")) return { rows: [{ id: 9 }] };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO price_observations")) return { rows: [{ id: 11 }] };
      throw new Error(`unexpected sql: ${sql}`);
    }
  };
  const saved = await observe({
    pool,
    registry,
    message: { chatId: -100, messageId: 7, userId: 5, text: "أريال ٢ك يدوي ٤٩٠ج ٤ق" }
  });
  assert.equal(saved.saved, 1, "a clear branded package price must be stored");
  assert.equal(saved.accepted[0].decision, "accepted");
  assert.match(calls.join("\n"), /product_text/);
  assert.match(calls.join("\n"), /INSERT INTO products/);

  const remote = buildPoolConfig("postgresql://bot:secret@gondola.proxy.rlwy.net:5432/railway?sslmode=require");
  assert.equal(remote.ssl.rejectUnauthorized, false);
  assert.equal(remote.connectionString.includes("sslmode"), false);
  assert.equal(stripSslParams("postgres://u:p@localhost/db?sslmode=require").includes("sslmode"), false);
  const local = buildPoolConfig("postgres://bot:secret@127.0.0.1:5432/borsa?sslmode=disable");
  assert.equal(local.ssl, false);
  const statements = splitSql("CREATE TABLE IF NOT EXISTS sample(id INT);\nCREATE INDEX IF NOT EXISTS idx_sample ON sample(id);\n");
  assert.equal(statements.length, 2);
  assert.ok(statements.every((sql) => !sql.includes(";")));

  const amazonHtml = `<div data-component-type="s-search-result" data-asin="B0ABCDEF12"><h2><a href="/dp/B0ABCDEF12"><span>Ariel laundry detergent 2kg</span></a></h2><span class="a-offscreen">250.00 EGP</span></div>`;
  const amazon = extractCards(amazonHtml, "amazon", "ariel");
  assert.equal(amazon.length, 1);
  assert.equal(amazon[0].price, 250);
  assert.equal(amazon[0].url, "https://www.amazon.eg/dp/B0ABCDEF12");
  await close();
  console.log("runtime repair tests: OK");
})().catch((error) => { console.error(error); process.exit(1); });
