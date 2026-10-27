"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.js"), "utf8");
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const runAll = fs.readFileSync(path.join(__dirname, "run-all.js"), "utf8");

assert.match(index, /String\(process\.env\.DEALS_SCHEDULER_ENABLED \|\| "true"\)\.toLowerCase\(\) !== "false"/,
  "scheduled deal scraping must be enabled by default for the deployment-ready development branch");
assert.match(index, /Enabled by default/,
  "startup must make the enabled-by-default behavior visible");
assert.doesNotMatch(index, /ENABLE_SCRAPER_TEST|scraper_test|testScraper/,
  "the removed manual scraper-test command must not be wired into the Borsa runtime");
assert.match(envExample, /^DEALS_SCHEDULER_ENABLED=true$/m, "the deployment template must enable scheduled deal newsletters by default");
assert.doesNotMatch(envExample, /^ENABLE_SCRAPER_TEST=/m,
  "do not advertise an unused manual scraper-test toggle");
assert.match(runAll, /deal-scraping-disabled\.test\.js/,
  "safety regression test must run in the normal suite");

console.log("deal newsletter default-enabled tests: OK");
