"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const start = source.indexOf("async function configureCommandMenus()");
const end = source.indexOf("\n}\n\nasync function ensureDb()", start);
assert.notEqual(start, -1, "configureCommandMenus must exist");
assert.notEqual(end, -1, "configureCommandMenus must have a closing boundary");
const body = source.slice(start, end);

assert.match(body, /type: "all_group_chats"\s*\}\s*\}\);/);
assert.match(body, /const groupCommands = \[\s*\{ command: "chemical"/);
assert.doesNotMatch(body.slice(body.indexOf("const groupCommands"), body.indexOf("];", body.indexOf("const groupCommands"))), /settings|antispam|schedule|warn|pricelist|approvechat|claim/);
assert.match(body, /type: "chat_member", chat_id: chatId, user_id: Number\(ownerId\)/);
assert.match(body, /type: "chat_member", chat_id: chatId, user_id: userId/);
assert.match(body, /type: "chat", chat_id: userId/);
assert.match(body, /if \(cmd && !isChemicalCommand && !\(await canControl\(ctx, m\)\)\) return;/,
  "menu visibility must not replace command-handler authorization");

console.log("command menu owner-scope regression test: OK");
