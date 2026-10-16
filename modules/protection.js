"use strict";

const { normalizeArabic } = require("../core/normalization");
const { dateKeyAt } = require("../core/cairo-time");

const LINK_RE = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i;
const BAD_WORD_PATTERNS = [
  /كس\s*ام/u, /كسمك/u, /عرص/u, /شرموط/u, /قحبة/u, /خول(?!ة)/u,
  /ابن\s*ال[كل]/u, /fuck\s*you/iu, /porn/iu, /onlyfans/iu, /xxx/iu,
  /استثمار\s*مضمون/u, /ربح\s*يومي/u, /forex/iu, /signals?\s*vip/iu
];
const SPAM_PATTERNS = [
  /(.)\1{9,}/u,
  /(?:ربح مضمون|اكسب بسرعة|استثمار مضمون|اضغط هنا|سجل الآن|اربح مجانا)/iu,
  /(?:crypto|bitcoin|forex).{0,35}(?:guaranteed|profit|investment)/iu,
];

function inspectMessage({ text = "", caption = "", isForward = false, trustedForward = false, messageType = "text" } = {}, options = {}) {
  const raw = `${text} ${caption}`.trim();
  const normalized = normalizeArabic(raw);
  const reasons = [];
  const maxLength = Number(options.maxLength || 5000);
  if (raw.length > maxLength) reasons.push("message_too_long");
  if (BAD_WORD_PATTERNS.some(re => re.test(normalized))) reasons.push("blocked_word");
  if (SPAM_PATTERNS.some(re => re.test(normalized))) reasons.push("spam_pattern");
  const links = (raw.match(/(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/ig) || []).length;
  if (links >= Number(options.maxLinks || 5)) reasons.push("excessive_links");
  if (isForward && !trustedForward && options.blockUntrustedForwards === true) reasons.push("untrusted_forward");
  return { allowed: reasons.length === 0, reasons, linkCount: links, length: raw.length };
}

// Per-process rate window: detection only. Cross-replica persistence is intentionally
// not claimed; production enforcement should use an atomic DB/Redis counter.
const rateWindows = new Map();
// Audit-only media counters, scoped by chat/user/type and Cairo-local day.
const mediaWindows = new Map();
function inspectRate({ chatId, userId, now = Date.now(), limit = 5, windowMs = 60_000 } = {}) {
  if (chatId == null || userId == null) return { limited: false, count: 0 };
  const key = `${chatId}:${userId}`;
  let events = rateWindows.get(key) || [];
  events = events.filter(ts => now - ts < windowMs);
  events.push(now);
  rateWindows.set(key, events);
  return { limited: events.length > limit, count: events.length, limit, windowMs };
}
function resetRateWindows() { rateWindows.clear(); }

// Durable cross-replica rate detection. It records each Telegram message once,
// then counts this user's messages in the configured rolling window. No deletion
// or muting is performed by this function.
let rateCleanupCounter = 0;
async function recordRate(pool, { chatId, userId, messageId, limit = 5, windowMs = 60_000 } = {}) {
  if (!pool || chatId == null || userId == null || messageId == null) {
    return { limited: false, count: 0, limit, windowMs, durable: false };
  }
  await pool.query(`INSERT INTO rate_limit_events(chat_id,user_id,message_id)
    VALUES($1,$2,$3) ON CONFLICT(chat_id,message_id) DO NOTHING`, [chatId, userId, messageId]);
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM rate_limit_events
    WHERE chat_id=$1 AND user_id=$2 AND occurred_at > NOW() - ($3 * INTERVAL '1 millisecond')`,
    [chatId, userId, Math.max(1, Number(windowMs) || 60_000)]);
  const count = Number(result.rows?.[0]?.count || 0);
  // Opportunistic bounded retention; old audit events are not needed for a 60s window.
  rateCleanupCounter = (rateCleanupCounter + 1) % 100;
  if (rateCleanupCounter === 0) {
    await pool.query("DELETE FROM rate_limit_events WHERE occurred_at < NOW() - INTERVAL '1 day'").catch(() => {});
  }
  return { limited: count > Number(limit), count, limit: Number(limit), windowMs: Number(windowMs), durable: true };
}
function inspectMediaQuota({ chatId, userId, messageType, now = Date.now(), photoLimit = 3, videoLimit = 1, mediaGroupId = null } = {}) {
  if (chatId == null || userId == null || !["photo", "video"].includes(messageType)) {
    return { applicable: false, exceeded: false, count: 0 };
  }
  const day = dateKeyAt(now);
  const key = `${day}:${chatId}:${userId}:${messageType}`;
  const count = (mediaWindows.get(key) || 0) + 1;
  mediaWindows.set(key, count);
  // Telegram sends each item in an album as a separate update. The counter intentionally
  // counts each media item; enforcement remains disabled pending product policy approval.
  const limit = messageType === "photo" ? photoLimit : videoLimit;
  return { applicable: true, exceeded: count > limit, count, limit, day, mediaGroupId: mediaGroupId || null };
}
function resetMediaWindows() { mediaWindows.clear(); }

// Durable cross-process media quota event. The unique chat/message key makes
// retries idempotent; PostgreSQL remains the source of truth when configured.
async function recordMediaQuota(pool, { chatId, userId, messageType, messageId, now = Date.now(), photoLimit = 3, videoLimit = 1, mediaGroupId = null } = {}) {
  if (!pool || chatId == null || userId == null || messageId == null || !["photo", "video"].includes(messageType)) {
    return { applicable: false, exceeded: false, count: 0, durable: false };
  }
  const day = dateKeyAt(now);
  await pool.query(`INSERT INTO media_quota_events(chat_id,user_id,media_type,quota_day,message_id,media_group_id)
    VALUES($1,$2,$3,$4::date,$5,$6) ON CONFLICT(chat_id,message_id) DO NOTHING`,
    [chatId, userId, messageType, day, messageId, mediaGroupId == null ? null : String(mediaGroupId)]);
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM media_quota_events
    WHERE chat_id=$1 AND user_id=$2 AND media_type=$3 AND quota_day=$4::date`,
    [chatId, userId, messageType, day]);
  const count = Number(result.rows?.[0]?.count || 0);
  const limit = Number(messageType === "photo" ? photoLimit : videoLimit);
  return { applicable: true, exceeded: count > limit, count, limit, day, mediaGroupId: mediaGroupId || null, durable: true };
}

function repeatedMessageKey(text) { return normalizeArabic(text).replace(/\s+/g, " ").trim(); }

module.exports = { inspectMessage, inspectRate, recordRate, resetRateWindows, inspectMediaQuota, recordMediaQuota, resetMediaWindows, repeatedMessageKey, LINK_RE, BAD_WORD_PATTERNS };
