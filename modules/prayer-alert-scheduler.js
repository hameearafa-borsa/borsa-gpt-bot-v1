"use strict";

const https = require("node:https");
const { partsAt, dateKeyAt } = require("../core/cairo-time");
const { isServiceEnabled } = require("../core/service-settings");

const CAIRO_ZONE = "Africa/Cairo";
const SOURCE_URL = "https://www.esa.gov.eg/praytimes.aspx";
const FETCH_TIMEOUT_MS = 9000;
const MAX_RESPONSE_BYTES = 1_500_000;
const POLL_INTERVAL_MS = 30_000;
const GRACE_MINUTES = 2;
const PRAYERS = Object.freeze([
  { key: "fajr", label: "الفجر", column: 3 },
  { key: "dhuhr", label: "الظهر", column: 5 },
  { key: "asr", label: "العصر", column: 6 },
  { key: "maghrib", label: "المغرب", column: 7 },
  { key: "isha", label: "العشاء", column: 8 }
]);
let cachedSchedule = null;
let cachedAt = 0;
let retryAfter = 0;

function normalizeDigits(value) {
  return String(value).replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}
function cellText(html) {
  return normalizeDigits(String(html).replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, dec) => String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10))))
    .replace(/\s+/g, " ").trim();
}
function parsePrayerTime(value) {
  const normalized = normalizeDigits(value).replace(/[：]/g, ":").trim();
  const match = normalized.match(/^(\d{1,2})\s*:\s*(\d{1,2})\s*([صم])$/);
  if (!match) return null;
  let hour = Number(match[1]), minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (match[3] === "ص") hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;
  return { hour, minute, text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}
function parseOfficialPrayerTimes(html, expectedDate) {
  const rows = String(html).match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(match => cellText(match[1]));
    if (cells.length < 9 || cells[0] !== "القاهرة" || cells[1] !== expectedDate) continue;
    const times = {};
    for (const prayer of PRAYERS) {
      const parsed = parsePrayerTime(cells[prayer.column]);
      if (!parsed) throw new Error(`prayer_time_invalid_${prayer.key}`);
      times[prayer.key] = parsed;
    }
    return { date: expectedDate, city: "القاهرة", timeZone: CAIRO_ZONE, times, source: SOURCE_URL };
  }
  throw new Error("official_cairo_prayer_times_not_found_for_date");
}
function getText(url = SOURCE_URL, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.hostname !== "www.esa.gov.eg" || target.pathname !== "/praytimes.aspx") {
      reject(new Error("prayer_source_not_allowed"));
      return;
    }
    const req = https.get(target, {
      headers: { "user-agent": "Borsa-GPT-Bot/1.0", accept: "text/html", "cache-control": "no-cache" },
      timeout: timeoutMs
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) req.destroy(new Error("prayer_source_response_too_large"));
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`prayer_source_http_${response.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    req.on("timeout", () => req.destroy(new Error("prayer_source_timeout")));
    req.on("error", reject);
  });
}
async function getDailyPrayerTimes({ now = new Date(), fetchText = getText, forceRefresh = false } = {}) {
  const date = dateKeyAt(now, CAIRO_ZONE);
  const current = Date.now();
  if (!forceRefresh && cachedSchedule?.date === date && current - cachedAt < 6 * 60 * 60_000) return cachedSchedule;
  if (!forceRefresh && current < retryAfter) throw new Error("prayer_source_retry_backoff");
  try {
    const html = await fetchText(SOURCE_URL);
    const parsed = parseOfficialPrayerTimes(html, date);
    cachedSchedule = parsed;
    cachedAt = current;
    retryAfter = 0;
    return parsed;
  } catch (error) {
    retryAfter = current + 5 * 60_000;
    throw error;
  }
}
function currentPrayerSlot(schedule, now = new Date()) {
  const date = dateKeyAt(now, CAIRO_ZONE);
  if (!schedule || schedule.date !== date || schedule.city !== "القاهرة") return null;
  const current = partsAt(new Date(now), CAIRO_ZONE);
  for (const prayer of PRAYERS) {
    const target = schedule.times?.[prayer.key];
    if (!target) continue;
    const targetMinute = target.hour * 60 + target.minute;
    const currentMinute = current.hour * 60 + current.minute;
    if (currentMinute >= targetMinute && currentMinute < targetMinute + GRACE_MINUTES) {
      return { date, prayer: prayer.key, label: prayer.label, time: target.text };
    }
  }
  return null;
}
function formatPrayerAlert(slot) {
  const prayer = PRAYERS.find(item => item.key === slot?.prayer);
  if (!prayer || !/^\d{2}:\d{2}$/.test(slot.time || "")) throw new Error("prayer_alert_slot_invalid");
  return `🕌 حان الآن موعد أذان ${prayer.label}\n\n🕰️ ${slot.time} بتوقيت القاهرة\n\nنسأل الله أن يتقبل منا و منكم صالح الأعمال .\n\nقوموا إلى صلاتكم يرحمنا و يرحمكم الله .`;
}
async function ensurePrayerAlertsSchema(pool) {
  if (!pool) throw new Error("prayer alerts require PostgreSQL");
  await pool.query(`CREATE TABLE IF NOT EXISTS prayer_alert_publications (
    id BIGSERIAL PRIMARY KEY,
    cairo_date DATE NOT NULL,
    prayer_key TEXT NOT NULL CHECK (prayer_key IN ('fajr','dhuhr','asr','maghrib','isha')),
    chat_id BIGINT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared','published','failed')),
    message_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    last_error TEXT,
    UNIQUE(cairo_date, prayer_key, chat_id)
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_prayer_alert_publications_date ON prayer_alert_publications(cairo_date DESC, prayer_key)");
}
async function publishPrayerSlot({ pool, telegram, now = new Date(), getTimes = getDailyPrayerTimes, onError = async () => {} }) {
  if (!pool || !telegram) return { skipped: true, reason: "database_or_telegram_missing" };
  const schedule = await getTimes({ now });
  const slot = currentPrayerSlot(schedule, now);
  if (!slot) return { skipped: true, reason: "outside_prayer_window" };
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  let locked = false;
  try {
    if (typeof pool.connect === "function") {
      const lock = await client.query("SELECT pg_try_advisory_lock($1, $2) AS locked", [731942, 5]);
      locked = lock.rows?.[0]?.locked === true;
      if (!locked) return { skipped: true, reason: "prayer_lock_busy" };
    }
    const groups = await client.query("SELECT chat_id FROM authorized_chats WHERE active=TRUE AND chat_type IN ('group','supergroup') ORDER BY chat_id");
    let sent = 0, failed = 0, alreadyHandled = 0;
    const message = formatPrayerAlert(slot);
    for (const group of groups.rows || []) {
      const chatId = String(group.chat_id);
      if (!(await isServiceEnabled(client, "prayers", Number(chatId)))) continue;
      const reservation = await client.query(`INSERT INTO prayer_alert_publications(cairo_date,prayer_key,chat_id,status)
        VALUES($1,$2,$3,'prepared') ON CONFLICT(cairo_date,prayer_key,chat_id) DO NOTHING RETURNING id`,
        [slot.date, slot.prayer, chatId]);
      const id = reservation.rows?.[0]?.id;
      if (!id) { alreadyHandled++; continue; }
      try {
        const result = await telegram.sendMessage(chatId, message, { disable_web_page_preview: true });
        await client.query("UPDATE prayer_alert_publications SET status='published',message_id=$2,published_at=NOW(),last_error=NULL WHERE id=$1", [id, result?.message_id || null]);
        sent++;
      } catch (error) {
        failed++;
        await client.query("UPDATE prayer_alert_publications SET status='failed',last_error=$2 WHERE id=$1", [id, String(error?.message || "telegram_send_failed").slice(0, 500)]).catch(() => {});
        await onError(error, { stage: "publish", date: slot.date, prayer: slot.prayer, chatId });
      }
    }
    return { skipped: false, date: slot.date, prayer: slot.prayer, sent, failed, alreadyHandled };
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock($1, $2)", [731942, 5]); }
      catch (error) { await onError(error, { stage: "unlock" }); }
    }
    if (client !== pool) client.release();
  }
}
function startPrayerAlertScheduler(options, { intervalMs = POLL_INTERVAL_MS } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await publishPrayerSlot(options); }
    catch (error) { await options.onError?.(error, { stage: "scheduler" }); }
    finally { running = false; }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
module.exports = {
  CAIRO_ZONE, SOURCE_URL, PRAYERS, GRACE_MINUTES, normalizeDigits, parsePrayerTime,
  parseOfficialPrayerTimes, getDailyPrayerTimes, currentPrayerSlot, formatPrayerAlert,
  ensurePrayerAlertsSchema, publishPrayerSlot, startPrayerAlertScheduler
};
