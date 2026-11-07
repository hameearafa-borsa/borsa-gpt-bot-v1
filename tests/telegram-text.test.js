"use strict";
const assert = require("node:assert/strict");
const { splitTelegramText, escapedHtmlLength } = require("../core/telegram-text");

const source = [
  "عنوان التركيبة\n",
  "| الخام | النسبة |\n",
  ...Array.from({ length: 180 }, (_, i) => "| خامة رقم " + (i + 1) + " | " + (i / 10).toFixed(1) + "% |\n"),
  "خطوات التصنيع بالتفصيل & < > ".repeat(900)
].join("");
const chunks = splitTelegramText(source, 900);
assert.ok(chunks.length > 1, "long content must be split into multiple messages");
assert.equal(chunks.join(""), source, "splitting must preserve every character and ordering");
assert.ok(chunks.every(chunk => escapedHtmlLength(chunk) <= 900), "no escaped chunk may exceed its configured budget");

const prefix = "🧪 المساعد الكيميائي\n\n@owner\n";
const suffix = "\n\nروابط وملاحظات ختامية";
const answerBudget = 3900 - prefix.length - suffix.length;
const finalChunks = splitTelegramText(source, answerBudget);
const bodies = finalChunks.map((chunk, index) => prefix + chunk + (index === finalChunks.length - 1 ? suffix : "\n\n(يتبع في الرسالة التالية)"));
assert.ok(bodies.every(body => body.length <= 4096), "assembled Telegram messages stay below 4096 characters");
assert.ok(finalChunks.every(chunk => escapedHtmlLength(chunk) + prefix.length + suffix.length <= 4096), "escaped answer and framing stay below Telegram limit");
assert.equal(finalChunks.join(""), source);
console.log("Telegram long-text chunking tests: OK");
