"use strict";
function parseMessageLink(value) {
  const source = String(value || "").trim();
  const match = source.match(/^https?:\\/\\/(?:www\\.)?(?:t\\.me|telegram\\.me)\\/(?:c\\/(\\d+)\\/(\\d+)|([A-Za-z0-9_]+)\\/(\\d+))(?:\\?(?:single|comment=\\d+))?\\/?$/i);
  if (!match) return null;
  if (match[1] && match[2]) return { chatId: Number(`-100${match[1]}`), messageId: Number(match[2]) };
  return { username: `@${match[3]}`, messageId: Number(match[4]) };
}
async function findCachedLinkedMessage({ pool, telegram, link, getMessageByRef }) {
  if (!link || !pool || typeof getMessageByRef !== "function") return { status: "not_cached", message: null };
  let chatId = link.chatId || null;
  if (!chatId && link.username) {
    try {
      const chat = await telegram.getChat(link.username);
      chatId = chat?.id || null;
    } catch {
      return { status: "chat_unavailable", message: null };
    }
  }
  if (!chatId) return { status: "chat_unavailable", message: null };
  const message = await getMessageByRef(pool, chatId, link.messageId);
  return { status: message ? "found" : "not_cached", message };
}
module.exports = { parseMessageLink, findCachedLinkedMessage };
