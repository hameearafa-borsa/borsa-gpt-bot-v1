"use strict";
const { spawnSync } = require("node:child_process");
const tests = ["deal-error-throttle.test.js", "webhook.test.js", "fatal-process.test.js", "telegram-startup-error.test.js", "group-discovery-static.test.js", "foundation.test.js", "price-intelligence.test.js", "merchant.test.js", "registry.test.js", "gpt-core.test.js", "adversarial.test.js", "legacy-services.test.js", "deal-sources-scheduler.test.js", "deal-identity.test.js", "legacy-admin.test.js", "admin-panel.test.js", "panel-context.test.js", "ai-error-diagnostics.test.js", "schema-static.test.js", "migrations.test.js", "weather-live-parser.test.js", "cairo-time.test.js", "protection-regression.test.js", "media-quota-durable.test.js", "rate-limit-durable.test.js", "scheduler-lock.test.js"];
for (const file of tests) {
  const r = spawnSync(process.execPath, [require("node:path").join(__dirname, file)], { encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log("ALL Borsa GBT Bot V1 Mona Lisa FOUNDATION TESTS: OK");
