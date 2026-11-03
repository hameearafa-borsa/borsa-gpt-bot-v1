"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const root = require("node:path").join(__dirname, "..");
const source = fs.readFileSync(require("node:path").join(root, "index.js"), "utf8");
const schedulerSource = ["deal-scheduler.js", "catalog-newsletter-scheduler.js", "weather-scheduler.js", "economic-newsletter.js", "prayer-alert-scheduler.js"]
  .map(file => fs.readFileSync(require("node:path").join(root, "modules", file), "utf8")).join("\n");

assert.match(source, /cmd === "panel" && m\.chatType === "private"/);
assert.match(source, /bot\.action\(\/\^panel:/);
assert.match(source, /bot\.action\(\/\^group-settings:/);
assert.match(source, /bot\.action\(\/\^owner:toggle:/);
assert.doesNotMatch(source, /panel:(protection|inactive)/);
assert.match(source, /async function configureCommandMenus\(\)/);
assert.match(source, /command: "chemical"/);
assert.match(source, /command: "weather"/);
assert.match(source, /cmd === "settings"/);
assert.match(source, /canManage\(ctx\.telegram, m\.chatId, m\.userId\)/);
assert.match(source, /serviceSettings\.setServiceSetting/);
assert.match(source, /serviceSettings\.isServiceEnabled/);
assert.match(schedulerSource, /isServiceEnabled\(pool, "deals"/);
assert.match(schedulerSource, /isServiceEnabled\(pool, "catalogs"/);
assert.match(schedulerSource, /isServiceEnabled\(pool, "weather"/);
assert.match(schedulerSource, /isServiceEnabled\(pool, "economic"/);
assert.match(schedulerSource, /isServiceEnabled\\(client, "prayers"/);
console.log("persistent service settings and role-scoped panel tests: OK");
