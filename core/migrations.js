"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_FILES = Object.freeze([
  "000_legacy_compat.sql",
  "001_core.sql",
  "002_operational.sql",
  "003_message_cache.sql",
  "004_legacy_services.sql",
  "005_deal_product_identity.sql",
  "006_media_quota_events.sql",
  "006_price_observation_identity.sql",
  "007_rate_limit_events.sql",
  "008_deal_error_notifications.sql",
  "009_group_approval.sql",
  "010_price_list_item_types.sql",
  "011_catalog_newsletter_snapshots.sql",
  "012_catalog_newsletter_deliveries.sql",
  "013_deal_publications_per_chat.sql",
]);

// A single transaction prevents a failed migration from leaving a partially
// applied schema. The transaction-scoped advisory lock serializes startup when
// more than one application instance attempts migrations at the same time.
const MIGRATION_LOCK_KEY = 0x424f5253;

async function runMigrations({ db, rootDir = path.join(__dirname, ".."), readFile = fs.readFileSync }) {
  if (!db || typeof db.withTransaction !== "function") {
    throw new TypeError("runMigrations requires a database with withTransaction(fn)");
  }

  return db.withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    for (const file of MIGRATION_FILES) {
      const fullPath = path.join(rootDir, "migrations", file);
      const sql = readFile(fullPath, "utf8");
      await client.query(sql);
    }
    return { applied: MIGRATION_FILES.length, files: [...MIGRATION_FILES] };
  });
}

module.exports = { MIGRATION_FILES, MIGRATION_LOCK_KEY, runMigrations };
