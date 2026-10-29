"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
assert.match(source, /bot\.action\(\/\^panel:\(home\|chemical\|prices\|lists\|merchants\|deals\|weather\|reports\|health\|diagnostics\)/, "service panel buttons must have a live callback handler");
assert.match(source, /cmd === "panel" && m\.chatType === "private"/, "the owner must be able to open the service panel");
assert.match(source, /const adminPanel = require\("\.\/modules\/admin-panel"\)/, "panel module must be wired into runtime");
assert.match(source, /SELECT COUNT\(\*\)::int AS count FROM merchants/, "merchant panel must show persisted merchant count");
assert.match(source, /cmd === "settings"/, "settings must be a real command handler");
assert.doesNotMatch(source, /panel:(protection|inactive)|cmd === "admin"|cmd === "antispam"|cmd === "schedule"|cmd === "warn"|cmd === "warnings"|cmd === "clearwarn"|cmd === "inactive"/, "GroupHelpBot moderation controls must not return");
assert.doesNotMatch(source, /moderation_settings|moderation_events|PROTECTION_ENFORCE|recordActivity/);
assert.match(source, /if \(cmd === "قائمة" \|\| cmd === "pricelist"\)/, "price-list service must remain");
assert.match(source, /if \(cmd === "weather" \|\| cmd === "الطقس"\)/, "weather service must remain");
assert.match(source, /if \(isChemicalCommand\)/, "chemical assistant must remain");
assert.match(source, /isAuthorizedChat\(m\.chatId\)/, "approved-group access gate must remain independent of moderation");

const settingsHandlerStart = source.indexOf('if (cmd === "settings" && ["private", "group", "supergroup"].includes(m.chatType))');
const approvedGroupGate = source.indexOf('if (m.chatType !== "private" && !(await isAuthorizedChat(m.chatId))) return;', settingsHandlerStart);
assert.ok(settingsHandlerStart >= 0 && approvedGroupGate > settingsHandlerStart, "/settings must be handled before the general approved-group service gate");
const settingsHandler = source.slice(settingsHandlerStart, approvedGroupGate);
assert.ok(settingsHandler.includes("permitted = await isPriceReviewer(ctx.telegram, m.userId)"), "private settings must be available to the bot owner and creators of active approved groups");
assert.ok(settingsHandler.includes("permitted = await canManage(ctx.telegram, m.chatId, m.userId)"), "group settings must be restricted to the bot owner or group creator");
assert.match(source, /bot\.action\(\/\^prv:\(approve\|new\|ignore\):\(\\d\+\)\$\/, async ctx => \{\s*\/\/ Stop Telegram's callback spinner before database and administrator API checks\.\s*await ctx\.answerCbQuery\(/, "review callbacks must acknowledge Telegram immediately before slow authorization checks");
assert.match(source, /bot\.action\(\/\^prv:edit:\(\\d\+\)\$\/, async ctx => \{\s*\/\/ Acknowledge immediately so Telegram does not leave the button spinning while access is checked\.\s*await ctx\.answerCbQuery\(/, "edit callback must acknowledge Telegram immediately before slow authorization checks");
console.log("Borsa runtime surface and settings authorization test: OK");
