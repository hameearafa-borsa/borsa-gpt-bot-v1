"use strict";
async function cacheMessage(pool, message) {
  if (!pool || !message?.chatId || !message?.messageId) return;
  await pool.query(`INSERT INTO observed_messages(chat_id,message_id,user_id,text,caption,message_type)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET text=COALESCE(EXCLUDED.text,observed_messages.text), caption=COALESCE(EXCLUDED.caption,observed_messages.caption)`,
    [message.chatId, message.messageId, message.userId || null, message.text || null, message.caption || null, message.messageType || "message"]);
}
async function getMessageByRef(pool, chatId, messageId) {
  if (!pool) return null;
  const r = await pool.query(`SELECT * FROM observed_messages WHERE chat_id=$1 AND message_id=$2 LIMIT 1`, [chatId, messageId]);
  return r.rows[0] || null;
}
module.exports = { cacheMessage, getMessageByRef };
