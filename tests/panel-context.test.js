"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
const start = source.indexOf("async function showPrivatePanel(");
assert.notEqual(start, -1, "showPrivatePanel must exist");

const end = source.indexOf("\n}\n", start);
assert.notEqual(end, -1, "showPrivatePanel must have a closing brace");

const body = source.slice(start, end);
assert.match(body, /ctx\.callbackQuery\s*&&\s*ctx\.answerCbQuery/,
  "answerCbQuery must be guarded by callbackQuery in showPrivatePanel");
assert.doesNotMatch(body, /if\s*\(ctx\.answerCbQuery\)/,
  "must not call answerCbQuery based on method presence alone");

console.log("panel context regression test: OK");
