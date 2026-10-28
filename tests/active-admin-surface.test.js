"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
assert.equal(source.includes('bot.action(/^panel:'), false, "private admin panel callback must be absent");
assert.doesNotMatch(source, /adminPanel|legacyAdmin|canControl|showPrivatePanel|isPrivateController/);
assert.match(source, /cmd === "settings"/, "settings must be a real command handler");
assert.doesNotMatch(source, /cmd === "admin"|cmd === "antispam"|cmd === "schedule"|cmd === "warn"|cmd === "warnings"|cmd === "clearwarn"|cmd === "inactive"/);
assert.doesNotMatch(source, /moderation_settings|moderation_events|PROTECTION_ENFORCE|recordActivity/);
assert.match(source, /if \(cmd === "قائمة" \|\| cmd === "pricelist"\)/, "price-list service must remain");
assert.match(source, /if \(cmd === "weather" \|\| cmd === "الطقس"\)/, "weather service must remain");
assert.match(source, /if \(isChemicalCommand\)/, "chemical assistant must remain");
assert.match(source, /isAuthorizedChat\(m\.chatId\)/, "approved-group access gate must remain independent of moderation");

const settingsHandlerStart = source.indexOf('if (cmd === "settings" && ["private", "group", "supergroup"].includes(m.chatType))');
const approvedGroupGate = source.indexOf('if (m.chatType !== "private" && !(await isAuthorizedChat(m.chatId))) return;', settingsHandlerStart);
assert.ok(settingsHandlerStart >= 0 && approvedGroupGate > settingsHandlerStart,
  "/settings must be handled before the general approved-group service gate");
const settingsHandler = source.slice(settingsHandlerStart, approvedGroupGate);
assert.ok(settingsHandler.includes("permitted = isMaster(m.userId)"),
  "private settings must be restricted to the bot owner");
assert.ok(settingsHandler.includes("permitted = await canManage(ctx.telegram, m.chatId, m.userId)"),
  "group settings must be restricted to the bot owner or group creator");

console.log("Borsa runtime surface and settings authorization test: OK");
