"use strict";
const assert = require("node:assert/strict");
const { send } = require("../core/log-channel");
const { retryAfterMs, isTelegramRateLimit, isTelegramRateLimitedNow } = require("../core/telegram-rate-limit");

async function main() {
  assert.equal(retryAfterMs({ message: "429: Too Many Requests: retry after 7" }), 7000);
  assert.equal(retryAfterMs({ message: "temporary Telegram failure" }), 30000);
  assert.equal(isTelegramRateLimit({ message: "429: Too Many Requests" }), true);
  assert.equal(isTelegramRateLimit({ message: "network socket closed" }), false);

  let calls = 0;
  const oldError = console.error;
  console.error = () => {};
  try {
    const bot = { telegram: { sendMessage: async () => {
      calls++;
      const error = new Error("429: Too Many Requests: retry after 5");
      throw error;
    } } };
    assert.equal(await send(bot, { module: "test", stage: "first" }), false);
    assert.equal(isTelegramRateLimitedNow(), true, "shared Telegram cooldown must be active after a 429");
    assert.equal(await send({ telegram: { sendMessage: async () => { calls++; } } }, { module: "test", stage: "during-cooldown" }), false);
    assert.equal(calls, 1, "log channel must not repeatedly hit Telegram while rate-limited");
  } finally {
    console.error = oldError;
  }
  console.log("log-channel-rate-limit.test.js: OK");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
