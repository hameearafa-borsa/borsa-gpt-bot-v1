"use strict";
const { spawnSync } = require("node:child_process");
const tests = ["foundation.test.js", "price-intelligence.test.js", "merchant.test.js", "registry.test.js", "gpt-core.test.js", "adversarial.test.js", "legacy-services.test.js", "deal-sources-scheduler.test.js", "legacy-admin.test.js", "admin-panel.test.js", "schema-static.test.js"];
for (const file of tests) {
  const r = spawnSync(process.execPath, [require("node:path").join(__dirname, file)], { encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log("ALL BORSA GPT BOT V1 FOUNDATION TESTS: OK");
