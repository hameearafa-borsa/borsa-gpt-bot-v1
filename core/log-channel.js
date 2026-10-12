"use strict";
const LOG_CHAT_ID = Number(process.env.LOG_CHAT_ID || -1004344288353);
function formatEvent(e) {
  const icon = e.severity === "error" ? "🚨" : e.severity === "warn" ? "⚠️" : "🕵️";
  const details = e.details ? (typeof e.details === "string" ? e.details : JSON.stringify(e.details)) : "";
  return `${icon} ${e.module || "bot"} / ${e.stage || "event"}\nالحالة: ${e.status || "ok"}${details ? `\nالتفاصيل: ${details}` : ""}${e.input_summary ? `\nالمدخل: ${e.input_summary}` : ""}`.slice(0, 3900);
}
async function send(bot, event) {
  if (!bot?.telegram?.sendMessage) return false;
  try { await bot.telegram.sendMessage(LOG_CHAT_ID, formatEvent(event), { disable_web_page_preview: true }); return true; }
  catch (err) { console.error("[LOG_CHANNEL_FAIL]", err.message); return false; }
}
module.exports = { LOG_CHAT_ID, formatEvent, send };
