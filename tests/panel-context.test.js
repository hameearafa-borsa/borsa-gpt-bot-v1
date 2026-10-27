"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const source = fs.readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");

assert.equal(source.includes("showPrivatePanel"), false, "the Borsa private admin panel must be removed");
assert.equal(source.includes('bot.action(/^panel:'), false, "panel callbacks must be removed");
assert.match(source, /async function configureCommandMenus\(\)/);
assert.match(source, /command: "chemical"/);
assert.match(source, /command: "weather"/);
assert.match(source, /cmd === "settings"/, "settings command must be handled");
assert.match(source, /canManage\(ctx\.telegram, m\.chatId, m\.userId\)/, "group settings must check the actual group creator");

assert.ok(source.includes(String.raw`\nحالة اعتماد البوت:`), "settings status must render a real line break");
assert.equal(source.includes(String.raw`\\nحالة اعتماد البوت:`), false, "settings status must not show literal \\n text");
assert.ok(source.includes(String.raw`${original}\n\n${status}`), "review decision must render real line breaks");
assert.equal(source.includes(String.raw`${original}\\n\\n${status}`), false, "review decision must not show literal \\n text");
console.log("legacy panel stays disabled while authorized settings are available: OK");
