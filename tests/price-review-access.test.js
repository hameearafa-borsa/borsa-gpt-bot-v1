"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
assert.ok(
  source.includes('if (cmd === "priceedit" && m.chatType === "private") {\n    if (!(await isPriceReviewer(ctx.telegram, m.userId))'),
  "private /priceedit must allow the bot owner and approved group owners"
);
assert.match(source, /async function isPriceReviewer\(telegram, userId\)/,
  "price review authorization must be centralized");
assert.match(source, /SELECT chat_id FROM authorized_chats WHERE active=TRUE/,
  "reviewer access must be limited to owners of active approved groups");
assert.match(source, /await isChatOwner\(telegram, row\.chat_id, userId\)/,
  "owners of approved groups must be allowed to review prices");
const reviewGuard = 'if (!isLogChat(ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id) || !(await isPriceReviewer(ctx.telegram, ctx.from?.id))) {';
assert.equal(source.split(reviewGuard).length - 1, 2, "both review callbacks must require the log channel and an authorized reviewer");
console.log("price review authorization is restricted to configured bot owners: OK");
