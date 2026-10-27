"use strict";

let rateLimitUntil = 0;

function retryAfterMs(error) {
  const message = String(error?.response?.description || error?.description || error?.message || "");
  const match = message.match(/retry after\s+(\d+)/i);
  return match ? Math.max(1, Number(match[1])) * 1000 : 30_000;
}

function isTelegramRateLimit(error) {
  return Number(error?.response?.error_code || error?.error_code || error?.code) === 429 ||
    /\b429\b|too many requests/i.test(String(error?.message || error?.description || error?.response?.description || ""));
}

function markTelegramRateLimited(error) {
  if (!isTelegramRateLimit(error)) return false;
  rateLimitUntil = Math.max(rateLimitUntil, Date.now() + retryAfterMs(error) + 1_000);
  return true;
}

function isTelegramRateLimitedNow() {
  return Date.now() < rateLimitUntil;
}

module.exports = { retryAfterMs, isTelegramRateLimit, markTelegramRateLimited, isTelegramRateLimitedNow };
