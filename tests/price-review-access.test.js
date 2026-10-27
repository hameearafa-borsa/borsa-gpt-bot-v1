"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
assert.ok(
  source.includes('if (cmd === "priceedit" && m.chatType === "private") {\n    if (!isMaster(m.userId)'),
  "private /priceedit must require a configured bot owner"
);
const reviewGuard = 'if (!isLogChat(ctx.chat?.id) || !isMaster(ctx.from?.id)) {';
assert.equal(source.split(reviewGuard).length - 1, 2, "both review callbacks must require a configured bot owner");
console.log("price review authorization is restricted to configured bot owners: OK");
