"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const source = fs.readFileSync(require.resolve("../index.js"), "utf8");
assert.match(source, /"my_chat_member"/);
assert.match(source, /"chat_member"/);
assert.match(source, /\[GROUP_RECOGNIZED\]/);
assert.match(source, /await bot\.telegram\.setWebhook\(webhookConfig\.url,\s*\{/);
assert.match(source, /createWebhookServer\(bot, webhookConfig\)/);
assert.doesNotMatch(source, /await bot\.launch\(/);
assert.match(source, /cmd === "claim" && \["group", "supergroup"\]/);
assert.match(source, /all_chat_administrators/, "admin menu must replace the legacy all_chat_administrators scope");
assert.doesNotMatch(source.slice(source.indexOf("async function configureCommandMenus"), source.indexOf("async function ensureDb")), /as3ar|aitest|delprice|orood|as3arday|setup/, "retired commands must not stay in the published menu");
console.log("GROUP DISCOVERY STATIC TESTS: OK");

const menuBlock = source.match(/const groupCommands = \[([\s\S]*?)\];/);
assert.ok(menuBlock, "group command menu must be declared");
assert.doesNotMatch(menuBlock[1], /command: "[^a-z0-9_]/, "Telegram command names must use Bot API-supported ASCII lowercase names");
assert.match(source, /cmd === "قائمة" \|\| cmd === "pricelist"/);
