"use strict";
const assert = require("node:assert/strict");
const { claimMessage } = require("../core/message-gate");

(async () => {
  const seen = new Set();
  const pool = {
    async query(sql, params) {
      assert.match(sql, /ON CONFLICT\s*\(chat_id,message_id,update_type\) DO NOTHING/i);
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
  console.log("message gate duplicate-claim tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
