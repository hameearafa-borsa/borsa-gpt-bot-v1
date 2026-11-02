"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "migrations", "015_price_review_notification_leases.sql"), "utf8");
const recovery = fs.readFileSync(path.join(root, "modules", "price-review-recovery.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.js"), "utf8");
const rateLimit = fs.readFileSync(path.join(root, "core", "telegram-rate-limit.js"), "utf8");

assert.match(migration, /ADD COLUMN IF NOT EXISTS notification_claim_token TEXT/i);
assert.match(migration, /ADD COLUMN IF NOT EXISTS notification_claimed_at TIMESTAMPTZ/i);
assert.match(recovery, /FOR UPDATE SKIP LOCKED/i);
assert.match(recovery, /notification_claimed_at < NOW\(\) - \(\$3 \* INTERVAL '1 second'\)/i);
assert.match(recovery, /notification_claim_token = \$4/i);
assert.match(recovery, /SET notification_claimed_at = NOW\(\)[\s\S]*?notification_claim_token = \$2/i);
assert.match(recovery, /AND notification_claim_token = \$3/i);

// Legacy lease helpers remain for maintenance; live runtime sends no review notices.
assert.ok(!index.includes("priceReviewRecovery.recoverPendingNotifications("));
assert.ok(!index.includes("priceReview.formatReviewMessage("));
assert.ok(index.includes("Pending price observations are intentionally silent"));
assert.match(rateLimit, /function markTelegramRateLimited/);
assert.match(rateLimit, /function isTelegramRateLimitedNow/);
console.log("legacy notification lease helpers and silent runtime policy tests: OK");
