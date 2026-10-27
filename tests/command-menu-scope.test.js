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
assert.doesNotMatch(body, /command: "(panel|approvechat|claim|antispam|schedule|warn|inactive)"/);
console.log("scoped Telegram command menu test: OK");
