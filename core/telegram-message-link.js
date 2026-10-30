"use strict";
function isDigits(value) {
  return typeof value === "string" && value.length > 0 && [...value].every(char => char >= "0" && char <= "9");
}
function parseMessageLink(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { return null; }
  if (!["t.me", "www.t.me", "telegram.me", "www.telegram.me"].includes(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 3 && parts[0].toLowerCase() === "c" && isDigits(parts[1]) && isDigits(parts[2])) {
    const internalChatId = Number(parts[1]);
    const messageId = Number(parts[2]);
    if (!Number.isSafeInteger(internalChatId) || !Number.isSafeInteger(messageId) || internalChatId <= 0 || messageId <= 0) return null;
    return { chatId: Number(`-100${parts[1]}`), messageId };
  }
  if (parts.length === 2 && /^[A-Za-z0-9_]+$/.test(parts[0]) && isDigits(parts[1])) {
    const messageId = Number(parts[1]);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
    return { username: `@${parts[0]}`, messageId };
  }
  return null;
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
