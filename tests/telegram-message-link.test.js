"use strict";
const assert = require("node:assert/strict");
const { parseMessageLink, parseMessageLinks, findCachedLinkedMessage } = require("../core/telegram-message-link");
assert.deepEqual(parseMessageLink("https://t.me/c/123456/789"), { chatId: -100123456, messageId: 789 });
assert.deepEqual(parseMessageLink("https://t.me/example_channel/789"), { username: "@example_channel", messageId: 789 });
assert.deepEqual(parseMessageLink("https://t.me/example_channel/789?single"), { username: "@example_channel", messageId: 789 });
assert.deepEqual(parseMessageLink("https://t.me/s/example_channel/789"), { username: "@example_channel", messageId: 789 },
  "public Telegram /s/ share links should resolve to the underlying channel post");
assert.equal(parseMessageLink("https://t.me/not-a-message"), null);
assert.equal(parseMessageLink("https://t.me/example_channel/999999999999999999999"), null);
assert.equal(parseMessageLink("https://t.me/c/0/789"), null);
const multipleLinks = parseMessageLinks("https://t.me/c/123456/789 https://t.me/example_channel/790");
assert.equal(multipleLinks.invalidCount, 0);
assert.equal(multipleLinks.links.length, 2, "two Telegram message links should be extracted from one /قائمة command");
assert.deepEqual(parseMessageLinks("https://t.me/c/123456/789 https://t.me/c/123456/789").links,
  [{ chatId: -100123456, messageId: 789 }], "duplicate message links must not duplicate catalog rows");
assert.equal(parseMessageLinks("https://t.me/not-a-message").invalidCount, 1,
  "invalid Telegram links must be reported rather than silently ignored");
(async () => {
  const calls = [];
  const lookup = async (_pool, chatId, messageId) => { calls.push([chatId, messageId]); return { text: "قائمة أسعار" }; };
  const publicResult = await findCachedLinkedMessage({ pool: {}, telegram: { async getChat(name) { assert.equal(name, "@example_channel"); return { id: -10055 }; } }, link: parseMessageLink("https://t.me/example_channel/789"), getMessageByRef: lookup });
  assert.equal(publicResult.status, "found");
  assert.equal(publicResult.message.text, "قائمة أسعار");
  assert.deepEqual(calls[0], [-10055, 789]);
  const privateResult = await findCachedLinkedMessage({ pool: {}, telegram: {}, link: parseMessageLink("https://t.me/c/123456/789"), getMessageByRef: lookup });
  assert.equal(privateResult.status, "found");
  assert.deepEqual(calls[1], [-100123456, 789]);
  const inaccessible = await findCachedLinkedMessage({ pool: {}, telegram: { async getChat() { throw new Error("not accessible"); } }, link: parseMessageLink("https://t.me/hidden_channel/12"), getMessageByRef: lookup });
  assert.equal(inaccessible.status, "chat_unavailable");
  console.log("TELEGRAM MESSAGE LINK TESTS: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
