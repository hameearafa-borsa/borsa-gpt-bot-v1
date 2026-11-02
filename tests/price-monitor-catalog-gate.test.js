"use strict";
const assert = require("node:assert/strict");
const { findOfficialCatalogMatch, observe } = require("../modules/price-monitor");

(async () => {
  const reference = {
    id: 91, price_kind: "wholesale", product_label: "دوف 350مل",
    weight_g: null, volume_ml: 350, pack_count: 12,
    unit_price_type: "بالكرتونة", raw_line: "دوف 350مل - 12 عبوة - 120"
  };
  const pool = {
    async query(sql, params) {
      if (sql.includes("FROM price_reference_observations")) {
        assert.deepEqual(params, [null, 350]);
        return { rows: [reference], rowCount: 1 };
      }
      if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT product_text, price_kind")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO price_observations")) return { rows: [{ id: 501 }], rowCount: 1 };
      throw new Error("unexpected catalog-gate query: " + sql);
    }
  };

  const matched = await findOfficialCatalogMatch(pool, {
    product_text: "دوف 350مل", weight_g: null, volume_ml: 350,
    pack_count: 12, unit_price_type: "بالكرتونة", offer_extra_weight_g: null
  });
  assert.equal(matched.id, 91, "a matching official catalog row must resolve the product identity");
  const missingCartonCount = await findOfficialCatalogMatch(pool, {
    product_text: "دوف 350مل", weight_g: null, volume_ml: 350,
    pack_count: null, unit_price_type: "بالكرتونة", offer_extra_weight_g: null
  });
  assert.equal(missingCartonCount, null,
    "a carton observation without a count must not attach to a configured carton reference");

  const wrongCartonCount = await findOfficialCatalogMatch(pool, {
    product_text: "دوف 350مل", weight_g: null, volume_ml: 350,
    pack_count: 24, unit_price_type: "بالكرتونة", offer_extra_weight_g: null
  });
  assert.equal(wrongCartonCount, null,
    "a different carton count must not be treated as the same official price unit");


  const unknown = await findOfficialCatalogMatch(pool, {
    product_text: "صنف غير موجود", weight_g: null, volume_ml: 350,
    pack_count: 12, unit_price_type: "بالكرتونة", offer_extra_weight_g: null
  });
  assert.equal(unknown, null, "brand or size similarity must not invent a catalog identity");

  const wrongUnit = await findOfficialCatalogMatch(pool, {
    product_text: "دوف 350مل", weight_g: null, volume_ml: 350,
    pack_count: 12, unit_price_type: "بالقطعة", offer_extra_weight_g: null
  });
  assert.equal(wrongUnit, null, "piece observations must not match carton references");

  const result = await observe({
    pool,
    message: { chatId: -100123, messageId: 990, userId: 700, text: "دوف 350مل 12 عبوة 125 ج" },
    registry: [],
    requireCatalogMatch: true
  });
  assert.equal(result.saved, 1, "a catalog-matched member observation must be persisted");
  assert.equal(result.savedRows[0].row.reference_observation_id, 91);
  assert.equal(result.savedRows[0].row.price_kind, "wholesale");
  assert.equal(result.savedRows[0].row.unit_price_type, "بالكرتونة");

  console.log("official price catalog gate: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
