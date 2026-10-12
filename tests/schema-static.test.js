"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const migrations = ["000_legacy_compat.sql", "001_core.sql", "002_operational.sql", "003_message_cache.sql", "004_legacy_services.sql"];
const sql = migrations.map(file => fs.readFileSync(path.join(root, "migrations", file), "utf8")).join("\n");
assert.match(sql, /CREATE TABLE IF NOT EXISTS merchants/i, "legacy merchants compatibility table must be created before dependent tables");
for (const table of ["authorized_chats", "processed_messages", "price_observations", "price_list_runs", "price_list_items", "deal_observations", "deal_publications", "diagnostic_events", "member_activity", "member_warnings"]) {
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i"), `missing additive table ${table}`);
}
for (const column of ["weight_g", "wholesale_carton_price", "consumer_price", "package_sale_price", "pack_count"]) {
  assert.match(sql, new RegExp(`\\b${column}\\b`, "i"), `missing price-list/weight attribute ${column}`);
}
assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN|SCHEMA)\b|\bTRUNCATE\b/i, "migrations must not delete existing schema/data");
assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i, "migrations must not delete existing rows");
console.log("additive migration static safety tests: OK");
