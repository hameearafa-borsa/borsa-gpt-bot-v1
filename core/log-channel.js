"use strict";
const { redactString, safeValue } = require("./diagnostics");
const { markTelegramRateLimited, isTelegramRateLimitedNow, isTelegramRateLimit } = require("./telegram-rate-limit");
const LOG_CHAT_ID = Number(process.env.LOG_CHAT_ID || -1004344288353);
let suppressedDuringRateLimit = 0;
let rateLimitNoticeShown = false;

function formatEvent(e) {
  const icon = e.severity === "error" ? "🚨" : e.severity === "warn" ? "⚠️" : "🕵️";
  const details = e.details ? redactString(typeof e.details === "string" ? e.details : JSON.stringify(safeValue(e.details))) : "";
  return redactString(`${icon} ${e.module || "bot"} / ${e.stage || "event"}\nالحالة: ${e.status || "ok"}${details ? `\nالتفاصيل: ${details}` : ""}${e.input_summary ? `\nالمدخل: ${e.input_summary}` : ""}`).slice(0, 3900);
}

async function send(bot, event) {
  if (!bot?.telegram?.sendMessage) return false;
  if (isTelegramRateLimitedNow()) {
    suppressedDuringRateLimit++;
    return false;
  }
  if (suppressedDuringRateLimit > 0) {
    console.warn("[LOG_CHANNEL_RATE_LIMIT_RECOVERED]", `suppressed=${suppressedDuringRateLimit}`);
    suppressedDuringRateLimit = 0;
    rateLimitNoticeShown = false;
  }
  try {
    await bot.telegram.sendMessage(LOG_CHAT_ID, formatEvent(event), { disable_web_page_preview: true });
    return true;
  } catch (err) {
    if (isTelegramRateLimit(err)) {
      markTelegramRateLimited(err);
      if (!rateLimitNoticeShown) {
        console.error("[LOG_CHANNEL_RATE_LIMITED]", redactString(err?.message || "Telegram rate limit"));
        rateLimitNoticeShown = true;
      }
      return false;
    }
    console.error("[LOG_CHANNEL_FAIL]", redactString(err?.message || "log_channel_error"));
    return false;
  }
}

module.exports = { LOG_CHAT_ID, formatEvent, send };
