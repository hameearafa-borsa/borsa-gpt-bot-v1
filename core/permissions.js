"use strict";
const MASTER_ID = 5256328556;
const LOG_CHAT_ID = Number(process.env.LOG_CHAT_ID || -1004344288353);
function idOf(value) { const n = Number(value); return Number.isSafeInteger(n) ? n : null; }
function reviewerUserIds() {
  return new Set(String(process.env.OWNER_ID || "").split(",").map(idOf).filter(x => x !== null && x > 0));
}
function authorizedUserIds() { return new Set([MASTER_ID, ...reviewerUserIds()]); }
// Only the fixed bot owner receives global administration privileges.
// OWNER_ID is reserved for price-review operators and must not elevate them.
function isMaster(userId) { return idOf(userId) === MASTER_ID; }
function isReviewOperator(userId) {
  const id = idOf(userId);
  return id !== null && reviewerUserIds().has(id);
}
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
module.exports = { MASTER_ID, LOG_CHAT_ID, idOf, authorizedUserIds, reviewerUserIds, isMaster, isReviewOperator, isLogChat, isChatOwner, canManage };
