"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const tests = ["active-admin-surface.test.js", "command-menu-scope.test.js", "message-gate.test.js", "chemical-assistant.test.js", "webhook.test.js", "price-list-image.test.js", "price-list-image-real.test.js", "price-list-command.test.js", "ai-routing.test.js", "price-list-local-first.test.js", "fatal-process.test.js", "telegram-startup-error.test.js", "group-discovery-static.test.js", "group-approval-transaction.test.js", "foundation.test.js", "price-intelligence.test.js", "price-monitor.test.js", "log-channel-rate-limit.test.js", "log-channel-callback-routing.test.js", "price-review.test.js", "price-review-access.test.js", "price-review-recovery.test.js", "price-review-inline-notification.test.js", "price-review-notification-lease.test.js", "merchant.test.js", "registry.test.js", "gpt-core.test.js", "adversarial.test.js", "legacy-services.test.js", "deal-scraping-disabled.test.js", "deal-sources-scheduler.test.js", "deal-publication-failure-paths.test.js", "catalog-newsletter.test.js", "catalog-newsletter-scheduler.test.js", "deal-identity.test.js", "legacy-admin.test.js", "admin-panel.test.js", "panel-context.test.js", "ai-error-diagnostics.test.js", "schema-static.test.js", "migrations.test.js", "weather-live-parser.test.js", "weather-scheduler.test.js", "economic-newsletter.test.js", "cairo-time.test.js", "protection-regression.test.js", "media-quota-durable.test.js", "rate-limit-durable.test.js", "scheduler-lock.test.js"];
const prefix = String(process.env.PREFIX || "");
const isTermuxOrAndroid = process.platform === "android" || /(^|\/)com\.termux(\/|$)/i.test(prefix);
for (const file of tests) {
  // Native sharp rasterization is tested on supported CI/server platforms, not Termux/Android.
  // Keep parser, validation, and SVG-content tests enabled in Termux.
  if (file === "price-list-image-real.test.js" && isTermuxOrAndroid) {
    console.log("SKIP price-list-image-real.test.js: native PNG rasterization is not a Termux/Android release gate; run it on a supported Node server/CI platform.");
    continue;
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log("ALL Borsa GBT Bot V1 Mona Lisa FOUNDATION TESTS: OK");
