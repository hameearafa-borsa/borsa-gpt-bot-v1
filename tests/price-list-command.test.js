"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.match(index, /cmd === "قائمة" \|\| cmd === "pricelist"/, "Arabic alias and Telegram-safe command must both work");
assert.match(index, /command: "pricelist", description: "قائمة أسعار الشركات"/, "menu must expose the working command");
assert.match(index, /db\.withTransaction\(client => persistPriceList\(client,/, "price-list persistence should be transactional through the dedicated persistence module");
const parser = require("../modules/price-list");
const metadata = parser.parseListMetadata("قائمة أسعار شركة باهي\nشهر أكتوبر 2026");
assert.equal(metadata.company, "شركة باهي");
assert.equal(metadata.month, "أكتوبر 2026");
assert.equal(metadata.isCompanyCatalog, true, "explicit company catalog heading enables carton defaults");
const rows = parser.deterministicList([
  "قائمة أسعار شركة باهي", "شهر أكتوبر 2026",
  "صابون دوش 60 جم * 48 قطعة 329.28",
  "جل باهي 1 كجم 12 زجاجة 215.50",
  "دوف 350 مل ق 121",
  "مسحوق باهي 2 كجم + 300 جم هدية 4 كيس 468.83"
].join("\n"));
assert.equal(rows.length, 4);
assert.equal(rows[0].package_sale_price, 329.28);
assert.equal(rows[0].pack_count, 48);
assert.equal(rows[0].unit_price_type, "بالكرتونة");
assert.equal(rows[1].package_sale_price, 215.5);
assert.equal(rows[1].pack_count, 12);
assert.equal(rows[2].package_sale_price, 121);
assert.equal(rows[2].unit_price_type, "بالقطعة");
assert.equal(rows[3].package_sale_price, 468.83);
assert.ok(rows.every(row => row.decision === "accepted"));
const persistence = fs.readFileSync(path.join(root, "modules", "price-list-persistence.js"), "utf8");
assert.match(persistence, /INSERT INTO price_reference_observations/, "accepted company rows must be stored in the separate official reference ledger");
assert.match(persistence, /if \(decision === "accepted"\)/, "only accepted company rows may enter the reference ledger");
assert.match(persistence, /parsedList\.month \|\| null/, "the official reference ledger must preserve the source period when available");
assert.match(persistence, /declaredPriceType \|\| null, referencePriceKind, productLabel/, "the official reference ledger must preserve declared price type and product identity");
assert.match(index, /accepted\.length >= 3 && companyNames\.length === 1/, "publishing requires 3 accepted items from one company");
assert.match(index, /renderPriceListImages/, "long lists must use adaptive multi-page rendering");
assert.match(index, /replyWithMediaGroup/, "multiple pages should be sent as a Telegram media group when supported");
assert.match(index, /offset \+= 10/, "long price lists must be split into Telegram-safe media groups of at most 10 photos");
assert.equal(pkg.dependencies.sharp, "^0.35.5", "sharp must be declared as a runtime dependency");
(async () => {
  const fallback = await parser.extractList({ generate: async () => { throw new Error("simulated AI timeout"); } }, [
    "قائمة أسعار شركة باهي", "شهر أكتوبر 2026",
    "صابون دوش 60 جم * 48 قطعة 329.28",
    "جل باهي 1 كجم 12 زجاجة 215.50",
    "دوف 350 مل ق 121"
  ].join("\n"));
  assert.equal(fallback.method, "deterministic", "AI timeout must preserve a valid local catalog parse");
  assert.equal(fallback.items.length, 3);
  assert.ok(fallback.items.every(row => row.decision === "accepted"));
  console.log("price-list command configuration tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
