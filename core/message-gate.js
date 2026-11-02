"use strict";

function isBotMessage(ctx, botUserId) {
  const from = ctx?.from;
  // Ignore every Telegram bot account, not only this bot's own account.
  // Other bots in the group must never become price observations or merchants.
  if (from?.is_bot === true) return true;
  const fromId = from?.id;
  return botUserId != null && fromId != null && String(fromId) === String(botUserId);
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
