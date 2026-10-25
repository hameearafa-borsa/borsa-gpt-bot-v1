"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
assert.match(source, /process\.env\.DEALS_SCHEDULER_ENABLED === "true" && process\.env\.DEALS_CHAT_ID/, "scheduled deal scraping must require explicit opt-in");
assert.match(source, /process\.env\.ENABLE_SCRAPER_TEST !== "true"/, "manual API test must be blocked by default");
assert.match(source, /اختبار الجلب متوقف لتجنب استهلاك رصيد ScraperAPI/, "blocked manual test must explain why no request is sent");
console.log("deal scraping opt-in safety tests: OK");
