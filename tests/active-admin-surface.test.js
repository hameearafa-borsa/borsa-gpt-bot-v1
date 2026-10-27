"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
assert.equal(source.includes('bot.action(/^panel:'), false, "private admin panel callback must be absent");
assert.doesNotMatch(source, /adminPanel|legacyAdmin|canControl|showPrivatePanel|isPrivateController/);
assert.doesNotMatch(source, /cmd === "settings"|cmd === "admin"|cmd === "antispam"|cmd === "schedule"|cmd === "warn"|cmd === "warnings"|cmd === "clearwarn"|cmd === "inactive"/);
assert.doesNotMatch(source, /moderation_settings|moderation_events|PROTECTION_ENFORCE|recordActivity/);
assert.match(source, /if \(cmd === "قائمة" \|\| cmd === "pricelist"\)/, "price-list service must remain");
assert.match(source, /if \(cmd === "weather" \|\| cmd === "الطقس"\)/, "weather service must remain");
assert.match(source, /if \(isChemicalCommand\)/, "chemical assistant must remain");
assert.match(source, /isAuthorizedChat\(m\.chatId\)/, "approved-group access gate must remain independent of moderation");

console.log("Borsa service-only runtime surface test: OK");
