"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.js"), "utf8");
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const runAll = fs.readFileSync(path.join(__dirname, "run-all.js"), "utf8");

assert.match(index, /process\.env\.DEALS_SCHEDULER_ENABLED === "true"/,
  "paid scheduled deal scraping must require explicit opt-in");
assert.match(index, /Disabled by default; set DEALS_SCHEDULER_ENABLED=true/,
  "startup must make the disabled-by-default behavior visible");
assert.match(envExample, /^DEALS_SCHEDULER_ENABLED=false$/m);
assert.doesNotMatch(index, /ENABLE_SCRAPER_TEST|scraper_test|اختبار مصدر العروض/,
  "manual scraper test routes must not be part of the active Borsa runtime");
assert.doesNotMatch(envExample, /^ENABLE_SCRAPER_TEST=/m,
  "obsolete manual scraper test setting must not be advertised");
assert.match(runAll, /deal-scraping-disabled\.test\.js/,
  "safety regression test must run in the normal suite");

console.log("deal scraping opt-in and no-manual-test safety tests: OK");
