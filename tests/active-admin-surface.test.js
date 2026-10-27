"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const start = source.indexOf("async function configureCommandMenus()");
const end = source.indexOf("\nasync function ensureDb()", start);
assert.notEqual(start, -1, "service command menu setup must exist");
assert.notEqual(end, -1, "service command menu setup must have a closing boundary");
const body = source.slice(start, end);

assert.match(body, /command: "chemical"/);
assert.match(body, /command: "weather"/);
assert.doesNotMatch(body, /panel|approvechat|claim|settings|antispam|schedule|warn|pricelist|inactive/);
assert.doesNotMatch(source, /bot\.action\(\/\^panel:/);
assert.doesNotMatch(source, /adminPanel|legacyAdmin|canControl|cmd === "antispam"|cmd === "schedule"|cmd === "warn"|cmd === "warnings"|cmd === "clearwarn"|cmd === "inactive"/);
assert.match(source, /isAuthorizedChat\(m\.chatId\)/, "group authorization remains a separate access-control gate");
assert.match(source, /if \(cmd === "قائمة" \|\| cmd === "pricelist"\)/, "price-list service must remain available");
assert.match(source, /if \(cmd === "weather" \|\| cmd === "الطقس"\)/, "weather service must remain available");
assert.match(source, /if \(isChemicalCommand\)/, "chemical assistant must remain available");

console.log("Borsa service-only command surface test: OK");
