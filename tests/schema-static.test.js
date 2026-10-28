"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const migrations = ["000_legacy_compat.sql", "001_core.sql", "002_operational.sql", "003_message_cache.sql", "004_legacy_services.sql", "005_deal_product_identity.sql", "006_media_quota_events.sql", "006_price_observation_identity.sql", "007_rate_limit_events.sql", "008_deal_error_notifications.sql", "009_group_approval.sql", "010_price_list_item_types.sql", "011_catalog_newsletter_snapshots.sql", "012_catalog_newsletter_deliveries.sql", "013_deal_publications_per_chat.sql", "014_price_review_queue.sql", "015_price_review_notification_leases.sql", "016_price_observation_history.sql", "017_price_observation_price_columns.sql", "018_price_observation_consumer_price.sql", "019_reviewed_product_pack_identity.sql"];
const sql = migrations.map(file => fs.readFileSync(path.join(root, "migrations", file), "utf8")).join("\n");
assert.match(sql, /CREATE TABLE IF NOT EXISTS merchants/i, "legacy merchants compatibility table must be created before dependent tables");
for (const table of ["authorized_chats", "processed_messages", "price_observations", "price_list_runs", "price_list_items", "deal_observations", "deal_publications", "diagnostic_events", "member_activity", "member_warnings", "catalog_newsletter_snapshots", "catalog_newsletter_deliveries", "price_review_queue", "reviewed_price_products"]) {
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i"), `missing additive table ${table}`);
}
for (const column of ["weight_g", "wholesale_carton_price", "consumer_price", "package_sale_price", "pack_count", "unit_price_type", "list_price"]) {
  assert.match(sql, new RegExp(`\\b${column}\\b`, "i"), `missing price-list/weight attribute ${column}`);
}
assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN|SCHEMA)\b|\bTRUNCATE\b/i, "migrations must not delete existing schema/data");
assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i, "migrations must not delete existing rows");
console.log("additive migration static safety tests: OK");
