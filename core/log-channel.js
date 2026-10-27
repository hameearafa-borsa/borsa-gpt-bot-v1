"use strict";
const { redactString, safeValue } = require("./diagnostics");
const LOG_CHAT_ID = Number(process.env.LOG_CHAT_ID || -1004344288353);

// Telegram applies bot-wide rate limits. Avoid retrying every diagnostic message
// while the log chat is throttled; otherwise the logger itself amplifies the flood.
let rateLimitUntil = 0;
let suppressedDuringRateLimit = 0;
let rateLimitNoticeShown = false;

function retryAfterMs(error) {
  const message = String(error?.response?.description || error?.description || error?.message || "");
  const match = message.match(/retry after\s+(\d+)/i);
  return match ? Math.max(1, Number(match[1])) * 1000 : 30_000;
}

function isTelegramRateLimit(error) {
  return Number(error?.response?.error_code || error?.error_code || error?.code) === 429 ||
    /\b429\b|too many requests/i.test(String(error?.message || error?.description || error?.response?.description || ""));
}

function formatEvent(e) {
  const icon = e.severity === "error" ? "🚨" : e.severity === "warn" ? "⚠️" : "🕵️";
  const details = e.details ? redactString(typeof e.details === "string" ? e.details : JSON.stringify(safeValue(e.details))) : "";
  return redactString(`${icon} ${e.module || "bot"} / ${e.stage || "event"}\nالحالة: ${e.status || "ok"}${details ? `\nالتفاصيل: ${details}` : ""}${e.input_summary ? `\nالمدخل: ${e.input_summary}` : ""}`).slice(0, 3900);
}

async function send(bot, event) {
  if (!bot?.telegram?.sendMessage) return false;
  const now = Date.now();
  if (now < rateLimitUntil) {
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
      rateLimitUntil = Date.now() + retryAfterMs(err) + 1_000;
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

module.exports = { LOG_CHAT_ID, formatEvent, send, retryAfterMs, isTelegramRateLimit };
