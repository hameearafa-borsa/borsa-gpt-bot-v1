"use strict";
const MASTER_ID = 5256328556;
const LOG_CHAT_ID = Number(process.env.LOG_CHAT_ID || -1004344288353);
function idOf(value) { const n = Number(value); return Number.isSafeInteger(n) ? n : null; }
function authorizedUserIds() { return new Set([MASTER_ID, ...String(process.env.OWNER_ID || "").split(",").map(idOf).filter(x => x !== null)]); }
function isMaster(userId) { const id = idOf(userId); return id !== null && authorizedUserIds().has(id); }
function isLogChat(chatId) { return idOf(chatId) === LOG_CHAT_ID; }
async function isChatOwner(telegram, chatId, userId) {
  if (!telegram || !chatId || !userId) return false;
  try {
    const admins = await telegram.getChatAdministrators(chatId);
    const owner = admins.find(a => a.status === "creator");
    return Boolean(owner && String(owner.user.id) === String(userId));
  } catch { return false; }
}
async function canManage(telegram, chatId, userId) { return isMaster(userId) || await isChatOwner(telegram, chatId, userId); }
module.exports = { MASTER_ID, LOG_CHAT_ID, idOf, authorizedUserIds, isMaster, isLogChat, isChatOwner, canManage };
