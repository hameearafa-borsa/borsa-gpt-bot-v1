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
assert.match(body, /command: "pricelist"/);
assert.match(body, /command: "settings"/, "private menu must expose the settings command");
assert.match(body, /type: "all_private_chats"/, "settings and service commands must appear in private chats");
assert.match(body, /type: "all_group_chats"/, "group service commands must remain scoped to groups");
assert.match(body, /all_chat_administrators/, "legacy all-admin command scope must be cleared so it cannot override the group menu");
assert.match(body, /type: "chat_administrators"/, "legacy per-group administrator command scopes must be cleared");
assert.match(body, /private_chat:\$\{userId\}.*type: "chat"/, "legacy private-chat command overrides must be cleared with a valid Telegram scope");
assert.match(body, /SELECT chat_id FROM authorized_chats/, "legacy per-chat command overrides must be discovered from configured groups");
assert.match(body, /getChatAdministrators\(chatId\)/, "group owners must be discovered so their stale private menu overrides can be cleared");
assert.match(body, /COMMAND_MENU_CLEAR\]/, "scope cleanup should be visible in startup logs");
assert.match(body, /deleteMyCommands\(\{ scope \}\)/, "legacy command scopes must be deleted with Telegram deleteMyCommands, not setMyCommands with an empty list");
assert.doesNotMatch(source, /setMyCommands\(\[\],\s*\{\s*scope\s*\}\)/, "empty setMyCommands calls are invalid and can leave stale menus in place");
assert.match(source, /async function clearLegacyCommandScopesForAddedGroup[\s\S]*?deleteMyCommands\(\{ scope \}\)/, "group-add cleanup must use the supported delete method too");
assert.match(body, /\["private", \[[\s\S]*?command: "panel"/, "the owner service panel belongs in the private command menu");
assert.doesNotMatch(body, /command: "(approvechat|claim|antispam|schedule|warn|inactive)"/, "GroupHelpBot moderation commands must stay out of Borsa menus");
assert.match(body, /\["groups", \[[\s\S]*?\], \{ type: "all_group_chats" \}\]/, "group menu must remain separately scoped");
assert.match(body, /for \(const \[name, commands, scope\] of menus\)/, "each Telegram command scope must be attempted independently");
assert.match(body, /COMMAND_MENU_SETUP_FAILED/, "scope failures must be reported instead of silently hiding menu setup problems");
assert.match(body, /COMMAND_MENU_SETUP\] scope=\$\{name\} status=ok/, "successful menu updates must be visible in startup logs");

assert.ok(source.includes("async function clearLegacyCommandScopesForAddedGroup(chatId, creatorId)"), "adding Borsa to a group must clear its stale menu overrides");
assert.ok(source.includes("clearLegacyCommandScopesForAddedGroup(chat.id, creatorId)"), "group-add event must clean Borsa's legacy scopes immediately");
assert.ok(source.includes("GroupHelpBot has its own bot token and command scopes"), "cleanup must explicitly remain isolated from GroupHelpBot");
console.log("scoped Telegram command menu test: OK");
