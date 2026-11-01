"use strict";
const assert = require("node:assert/strict");
const { deterministicList } = require("../modules/price-list");
const { observe } = require("../modules/price-monitor");
const { parsePackageType } = require("../modules/price-intelligence");
const registry = require("../data/product-registry.json");

const pearl = `أسعار بيرل – أكتوبر
..... أوتوماتيك
• 9 ك: 505.31 | جملة 487.40 | مستهلك 525
• 5 ك: 308.43 | جملة 915.87 | مستهلك 325
• 2.5 ك: 179.15 | جملة 716.63 | مستهلك 200
..... أوزان وشكاير
• شكارة 10 ك: 618.35 | مستهلك 630
• شكارة 7 ك: 432.84 | مستهلك 450
• 2 ك: 129.22 | جملة 516.90 | مستهلك 145
• 1.5 ك: 98.96 | جملة 395.85 | مستهلك 110
• 1 ك: 66.28 | جملة 265.15 | مستهلك 75
.. العبوات الصغيرة
• 290 جم: 22.03 | جملة 176.29 | مستهلك 25
• 160 جم: 12 | جملة 144.06 | مستهلك 15
• 120 جم: 8.46 | جملة 135.49 | مستهلك 10
• 50 جم: 3.96 | جملة 47.52 | مستهلك 5
• 30 جم: 3.79 | جملة 75.95 | مستهلك 5`;

(async () => {
  const expected = deterministicList(pearl);
  const inserts = [];
  const pool = { async query(sql, params) {
    if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO price_observations")) {
      inserts.push(params);
      return { rows: [{ id: inserts.length }], rowCount: 1 };
    }
    throw new Error("Unexpected query: " + sql);
  } };
  const actual = await observe({
    pool,
    message: { chatId: -1001, messageId: 7001, text: pearl },
    registry
  });

  assert.equal(expected.length, 13);
  assert.equal(actual.saved, expected.length);
  assert.equal(actual.savedRows.length, expected.length);

  // Compare source-derived product facts; price columns are mapped intentionally:
  // monitor.package_sale_price is the selected wholesale observation, while
  // listed_base_price retains /قائمة's package_sale_price when a separate
  // wholesale_carton_price exists.
  for (let i = 0; i < expected.length; i++) {
    const list = expected[i];
    const monitor = actual.savedRows[i].row;
    assert.equal(monitor.weight_g, list.weight_g, "weight mismatch row " + i);
    assert.equal(monitor.volume_ml, list.volume_ml, "volume mismatch row " + i);
    assert.equal(monitor.pack_count, list.pack_count, "pack_count mismatch row " + i);
    assert.equal(monitor.consumer_price, list.consumer_price, "consumer price mismatch row " + i);
    assert.equal(monitor.unit_price_type, list.unit_price_type, "unit mismatch row " + i);
    assert.equal(monitor.package_type, parsePackageType(list.raw_line) || null, "package type mismatch row " + i);
    assert.equal(monitor.package_sale_price,
      list.wholesale_carton_price ?? list.package_sale_price,
      "selected monitor price mismatch row " + i);
    assert.equal(monitor.listed_base_price,
      list.wholesale_carton_price != null && list.package_sale_price !== list.wholesale_carton_price
        ? list.package_sale_price : null,
      "base/list price mapping mismatch row " + i);
    assert.equal(monitor.explicit_wholesale_label_price,
      list.wholesale_carton_price ?? null,
      "explicit wholesale mapping mismatch row " + i);
    assert.equal(monitor.needs_review, list.decision !== "accepted" || (
      list.wholesale_carton_price != null && list.package_sale_price != null &&
      Math.abs(list.package_sale_price - list.wholesale_carton_price) > 0.0001
    ) || !list.unit_price_type, "review-state mismatch row " + i);
  }

  // A replay with the same Telegram chat/message/raw row must be idempotent.
  let duplicateInserts = 0;
  const duplicatePool = { async query(sql) {
    if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
    if (sql.includes("INSERT INTO price_observations")) { duplicateInserts++; return { rows: [{ id: 1 }], rowCount: 1 }; }
    throw new Error("Unexpected duplicate query: " + sql);
  } };
  const replay = await observe({
    pool: duplicatePool,
    message: { chatId: -1001, messageId: 7001, text: pearl },
    registry
  });
  assert.equal(replay.saved, 0);
  assert.equal(duplicateInserts, 0);

  console.log("price-monitor-parity tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
