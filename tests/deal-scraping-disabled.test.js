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
assert.match(index, /process\.env\.ENABLE_SCRAPER_TEST !== "true"/,
  "manual ScraperAPI testing must be blocked by default");
assert.match(index, /لا يُرسل أي طلب خارجي/,
  "blocked manual test must explicitly confirm no external request is sent");
assert.match(envExample, /^DEALS_SCHEDULER_ENABLED=false$/m);
assert.match(envExample, /^ENABLE_SCRAPER_TEST=false$/m);
assert.match(runAll, /deal-scraping-disabled\.test\.js/,
  "safety regression test must run in the normal suite");

console.log("deal scraping opt-in safety tests: OK");
