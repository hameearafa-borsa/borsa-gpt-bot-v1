"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { deterministicList, parseListMetadata } = require("../modules/price-list");
const { observe, isBulkPriceList } = require("../modules/price-monitor");
const registry = require("../data/product-registry.json");

(async () => {
  const source = fs.readFileSync(path.join(__dirname, "fixtures-unilever-oct-2026.txt"), "utf8");
  assert.equal(isBulkPriceList(source), true, "Unilever fixture must enter bulk catalog monitoring");
  const metadata = parseListMetadata(source);
  const parsed = deterministicList(source);
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
  const monitored = await observe({
    pool, registry,
    message: { chatId: -1001, messageId: 99001, text: source }
  });
  const summary = monitored.savedRows.map(({row}) => ({
    source: row.raw_line,
    product: row.product_text,
    price: row.package_sale_price,
    unit: row.unit_price_type,
    confidence: row.confidence,
    decision: row.decision,
    needs_review: row.needs_review,
    pack_count: row.pack_count,
    volume_ml: row.volume_ml,
    weight_g: row.weight_g,
    package_type: row.package_type,
    offer_extra_weight_g: row.offer_extra_weight_g
  }));
  console.log("UNILEVER_MONITOR_DIAGNOSTIC " + JSON.stringify({
    metadata,
    deterministic_rows: parsed.length,
    deterministic_accepted: parsed.filter(x => x.decision === "accepted").length,
    deterministic_review: parsed.filter(x => x.decision === "review").length,
    deterministic_skipped: parsed.filter(x => x.decision === "skipped").length,
    monitor_rows: monitored.accepted.length,
    saved: monitored.saved,
    pending: monitored.accepted.filter(x => x.decision === "pending").length,
    accepted: monitored.accepted.filter(x => x.decision === "accepted").length,
    summary
  }));
  assert.equal(monitored.saved, monitored.savedRows.length);
  assert.equal(monitored.saved, monitored.accepted.length);
})().catch(error => { console.error(error); process.exitCode = 1; });
