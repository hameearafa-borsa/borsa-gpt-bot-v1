"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
assert.match(
  source,
  /if \(!m\.chatId \|\| \(isLogChat\(m\.chatId\) && !ctx\.callbackQuery\)\) return;/,
  "log-channel message suppression must not swallow callback queries"
);
assert.match(
  source,
  /bot\.action\(\/\^prv:\(approve\|new\|ignore\):\(\\d\+\)\$\//,
  "review approve/new/ignore callback handler must remain registered"
);
assert.match(
  source,
  /bot\.action\(\/\^prv:edit:\(\\d\+\)\$\//,
  "review edit callback handler must remain registered"
);
console.log("log-channel callback routing regression test: OK");
