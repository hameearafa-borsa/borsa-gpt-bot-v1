"use strict";
const assert = require("node:assert/strict");
const { isBotMessage, claimMessage } = require("../core/message-gate");

(async () => {
  assert.equal(isBotMessage({ from: { id: 123, is_bot: true } }, 999), true,
    "messages from any Telegram bot account must be ignored");
  assert.equal(isBotMessage({ from: { id: 999, is_bot: false } }, 999), true,
    "this bot's own account must still be ignored");
  assert.equal(isBotMessage({ from: { id: 123, is_bot: false } }, 999), false,
    "ordinary human messages must remain eligible");
  assert.equal(isBotMessage({ from: { id: 123 } }, 999), false,
    "missing is_bot metadata must not reject a human message without matching the bot ID");

  const seen = new Set();
  const pool = {
    async query(sql, params) {
      assert.ok(sql.includes("ON CONFLICT (chat_id,message_id,update_type) DO NOTHING"));
      const key = params.join(":");
      if (seen.has(key)) return { rowCount: 0, rows: [] };
      seen.add(key);
      return { rowCount: 1, rows: [{ id: seen.size }] };
    }
  };

  assert.equal(await claimMessage(pool, { chatId: -100123, messageId: 77, updateType: "message" }), true,
    "first delivery should be claimed");
  assert.equal(await claimMessage(pool, { chatId: -100123, messageId: 77, updateType: "message" }), false,
    "duplicate delivery should be rejected before downstream handlers call Gemini or reply");
  assert.equal(await claimMessage(pool, { chatId: -100123, messageId: 77, updateType: "edited_message" }), true,
    "edited-message updates are a distinct update type under the current schema key");
  assert.equal(await claimMessage(null, { chatId: -100123, messageId: 77 }), true,
    "no-pool behavior is permissive and must not be mistaken for durable deduplication");
  console.log("message gate bot filtering and duplicate-claim tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
