"use strict";

const { partsAt, dateKeyAt } = require("../core/cairo-time");
const { getDailyWeatherReport } = require("./weather");

const WEATHER_SLOTS = Object.freeze([{ hour: 11, minute: 0, key: "11" }, { hour: 20, minute: 0, key: "20" }]);
const GRACE_MINUTES = 5;

function currentWeatherSlot(now = new Date()) {
  const p = partsAt(new Date(now), "Africa/Cairo");
  const slot = WEATHER_SLOTS.find(s => p.hour === s.hour && p.minute >= s.minute && p.minute < s.minute + GRACE_MINUTES);
  return slot ? { date: dateKeyAt(now, "Africa/Cairo"), key: slot.key, hour: slot.hour, minute: p.minute } : null;
}

async function ensureWeatherSchedulerSchema(pool) {
  if (!pool) throw new Error("weather scheduler requires PostgreSQL");
  await pool.query(`CREATE TABLE IF NOT EXISTS weather_publications (
    id BIGSERIAL PRIMARY KEY,
    cairo_date DATE NOT NULL,
    slot_key TEXT NOT NULL CHECK (slot_key IN ('11','20')),
    chat_id BIGINT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared','published','failed')),
    message_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    last_error TEXT,
    UNIQUE(cairo_date, slot_key, chat_id)
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_weather_publications_date ON weather_publications(cairo_date DESC, slot_key)");
}

async function reservePublication(pool, date, slotKey, chatId) {
  const inserted = await pool.query(`INSERT INTO weather_publications(cairo_date,slot_key,chat_id,status)
    VALUES($1,$2,$3,'prepared') ON CONFLICT(cairo_date,slot_key,chat_id) DO NOTHING RETURNING id`, [date, slotKey, chatId]);
  if (inserted.rowCount) return inserted.rows[0].id;
  // A failed send can still have reached Telegram if its acknowledgement was lost.
  // Treat every existing reservation as handled; reconcile failed rows manually.
  return null;
}

async function publishWeatherSlot({ pool, telegram, now = new Date(), getReport = getDailyWeatherReport, onError = async () => {} }) {
  if (!pool || !telegram) return { skipped: true, reason: "database_or_telegram_missing" };
  const slot = currentWeatherSlot(now);
  if (!slot) return { skipped: true, reason: "outside_weather_window" };

  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  let locked = false;
  try {
    if (typeof pool.connect === "function") {
      const result = await client.query("SELECT pg_try_advisory_lock($1, $2) AS locked", [731942, 2]);
      locked = result.rows?.[0]?.locked === true;
      if (!locked) return { skipped: true, reason: "weather_lock_busy" };
    }
    const groups = await client.query(`SELECT chat_id FROM authorized_chats
      WHERE active=TRUE AND chat_type IN ('group','supergroup') ORDER BY chat_id`);
    if (!groups.rows?.length) return { skipped: true, reason: "no_active_authorized_groups" };

    // Fetch and validate the complete four-city bulletin before reserving or sending
    // anything, so a failed city can never produce a partial group post.
    let report;
    try { report = await getReport({ now }); }
    catch (error) {
      await onError(error, { stage: "fetch", date: slot.date, slot: slot.key });
      return { skipped: true, reason: "weather_data_incomplete" };
    }

    let sent = 0, failed = 0, alreadyHandled = 0;
    for (const group of groups.rows) {
      const chatId = String(group.chat_id);
      const id = await reservePublication(client, slot.date, slot.key, chatId);
      if (!id) { alreadyHandled++; continue; }
      try {
        const msg = await telegram.sendMessage(chatId, report.message, { disable_web_page_preview: true });
        await client.query("UPDATE weather_publications SET status='published',message_id=$2,published_at=NOW(),last_error=NULL WHERE id=$1", [id, msg?.message_id || null]);
        sent++;
      } catch (error) {
        failed++;
        await client.query("UPDATE weather_publications SET status='failed',last_error=$2 WHERE id=$1", [id, String(error?.message || "telegram_send_failed").slice(0, 500)]).catch(() => {});
        await onError(error, { stage: "publish", date: slot.date, slot: slot.key, chatId });
      }
    }
    return { skipped: false, date: slot.date, slot: slot.key, sent, failed, alreadyHandled };
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock($1, $2)", [731942, 2]); }
      catch (error) { await onError(error, { stage: "unlock" }); }
    }
    if (client !== pool) client.release();
  }
}

function startWeatherScheduler(options, { intervalMs = 30_000 } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await publishWeatherSlot(options); }
    catch (error) { await options.onError?.(error, { stage: "scheduler" }); }
    finally { running = false; }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { WEATHER_SLOTS, GRACE_MINUTES, currentWeatherSlot, ensureWeatherSchedulerSchema, publishWeatherSlot, startWeatherScheduler };
