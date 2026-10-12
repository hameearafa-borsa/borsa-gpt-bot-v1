"use strict";

function isBotMessage(ctx, botUserId) {
  const from = ctx?.from?.id;
  return botUserId != null && from != null && String(from) === String(botUserId);
}

function isLogChat(chatId, logChatId = Number(process.env.LOG_CHAT_ID || -1004344288353)) {
  return String(chatId) === String(logChatId);
}

function isCommand(text) {
  return /^\s*\//.test(String(text || ""));
}

async function claimMessage(pool, { chatId, messageId, updateType = "message" }) {
  if (!pool) return true;
  const r = await pool.query(
    `INSERT INTO processed_messages (chat_id,message_id,update_type)
     VALUES ($1,$2,$3)
     ON CONFLICT (chat_id,message_id,update_type) DO NOTHING
     RETURNING id`,
    [chatId, messageId, updateType]
  );
  return r.rowCount === 1;
}

module.exports = { isBotMessage, isLogChat, isCommand, claimMessage };
