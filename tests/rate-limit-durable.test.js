"use strict";
const assert = require("node:assert/strict");
const { recordRate } = require("../modules/protection");
const events = new Map();
const fakePool = { async query(sql, args) {
  if (sql.includes("INSERT INTO rate_limit_events")) {
    const [chatId, userId, messageId] = args;
    const key = `${chatId}:${messageId}`;
    if (!events.has(key)) events.set(key, { chatId, userId, messageId });
    return { rows: [] };
  }
  if (sql.includes("SELECT COUNT(*)::int AS count FROM rate_limit_events")) {
    const [chatId, userId] = args;
    return { rows: [{ count: [...events.values()].filter(e => e.chatId === chatId && e.userId === userId).length }] };
  }
  if (sql.includes("DELETE FROM rate_limit_events")) return { rows: [] };
  throw new Error(`Unexpected SQL: ${sql}`);
}};
(async () => {
  const base = { chatId: -1001, userId: 7, limit: 2, windowMs: 60_000 };
  assert.equal((await recordRate(fakePool, { ...base, messageId: 1 })).limited, false);
  assert.equal((await recordRate(fakePool, { ...base, messageId: 1 })).count, 1, "retry must not double-count");
  assert.equal((await recordRate(fakePool, { ...base, messageId: 2 })).limited, false);
  const third = await recordRate(fakePool, { ...base, messageId: 3 });
  assert.equal(third.count, 3);
  assert.equal(third.limited, true);
  assert.equal(third.durable, true);
  assert.equal((await recordRate(fakePool, { ...base, userId: 8, messageId: 4 })).count, 1, "users are isolated");
  assert.equal((await recordRate(fakePool, { ...base, messageId: undefined })).durable, false);
  console.log("rate-limit-durable.test.js: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
