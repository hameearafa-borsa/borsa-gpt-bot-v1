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
assert.match(source, /Promise\.all\(\(groups\.rows \|\| \[\]\)\.map\(row =>\s*isChatOwner\(telegram, row\.chat_id, userId\)\s*\)\)/,
  "owners of approved groups must be checked concurrently to keep review callbacks responsive");
const reviewGuard = 'if (!isLogChat(ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id) || !(await isPriceReviewer(ctx.telegram, ctx.from?.id))) {';
assert.equal(source.split(reviewGuard).length - 1, 2, "both review callbacks must require the log channel and an authorized reviewer");
assert.match(source, /Promise\.all\(\(groups\.rows \|\| \[\]\)\.map\(row =>\s*isChatOwner\(telegram, row\.chat_id, userId\)\s*\)\)/,
  "reviewer authorization should check active group owners concurrently to keep callbacks responsive");

assert.match(source, /async function startPriceEdit\(ctx, id\)/,
  "review edit button must start a guided private editing flow");
assert.match(source, /سنكمل التعديل خطوة بخطوة، دون رموز خاصة أو تنسيق معقد/,
  "guided edit instructions must avoid pipe-separated formatting");
assert.match(source, /if \(session\.step === "product"\)/);
assert.match(source, /if \(session\.step === "price"\)/);
assert.match(source, /if \(session\.step === "weight"\)/);
assert.match(source, /if \(session\.step === "volume"\)/);
assert.match(source, /if \(session\.step === "packs"\)/);
assert.match(source, /priceEditSessions\.delete\(Number\(m\.userId\)\)/,
  "edit flow should clear its state after cancellation or completion");
assert.match(source, /\/(?:cancel|إلغاء)/,
  "reviewers must be able to cancel a guided edit");
assert.match(source, /await startPriceEdit\(ctx, id\)/,
  "the edit button must launch the guided flow");

console.log("price review authorization and guided edit flow checks: OK");
