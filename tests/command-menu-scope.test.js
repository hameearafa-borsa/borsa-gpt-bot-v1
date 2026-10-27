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
assert.doesNotMatch(body, /panel|approvechat|claim|settings|antispam|schedule|warn|pricelist|inactive/);
console.log("service-only Telegram command menu test: OK");
