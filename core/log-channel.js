"use strict";
const { redactString, safeValue } = require("./diagnostics");
const LOG_CHAT_ID = Number(process.env.LOG_CHAT_ID || -1004344288353);
function formatEvent(e) {
  const icon = e.severity === "error" ? "🚨" : e.severity === "warn" ? "⚠️" : "🕵️";
  const details = e.details ? redactString(typeof e.details === "string" ? e.details : JSON.stringify(safeValue(e.details))) : "";
  return redactString(`${icon} ${e.module || "bot"} / ${e.stage || "event"}\nالحالة: ${e.status || "ok"}${details ? `\nالتفاصيل: ${details}` : ""}${e.input_summary ? `\nالمدخل: ${e.input_summary}` : ""}`).slice(0, 3900);
}
async function send(bot, event) {
  if (!bot?.telegram?.sendMessage) return false;
  try { await bot.telegram.sendMessage(LOG_CHAT_ID, formatEvent(event), { disable_web_page_preview: true }); return true; }
  catch (err) { console.error("[LOG_CHANNEL_FAIL]", redactString(err?.message || "log_channel_error")); return false; }
}
module.exports = { LOG_CHAT_ID, formatEvent, send };
