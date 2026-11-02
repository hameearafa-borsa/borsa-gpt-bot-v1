"use strict";

const { partsAt, dateKeyAt } = require("../core/cairo-time");

const CAIRO_ZONE = "Africa/Cairo";
const DAILY_HOUR = 20;
const DAILY_MINUTE = 0;
const GRACE_MINUTES = 5;
const MAX_DIGEST_ROWS = 100;

function currentPriceDigestSlot(now = new Date()) {
  const p = partsAt(new Date(now), CAIRO_ZONE);
  if (p.hour < DAILY_HOUR || (p.hour === DAILY_HOUR && p.minute < DAILY_MINUTE)) return null;
  return { date: dateKeyAt(now, CAIRO_ZONE), key: "daily", hour: p.hour, minute: p.minute };
}

function formatDailyPriceDigest(rows = [], date) {
  const day = String(date || "");
  const header = [
    "📊 نشرة رصد أسعار المنظفات اليومية",
    day ? `📅 ${day} — بتوقيت القاهرة` : null,
    "الأسعار التالية رُصدت اليوم واعتمدت فقط؛ وهي أسعار جملة."
  ].filter(Boolean);
  if (!rows.length) return [...header, "", "لم تُسجل اليوم أسعار جملة مؤكدة."].join("\n");

  const lines = rows.map((row, index) => {
    const name = String(row.product_text || "صنف غير محدد").replace(/\s+/g, " ").trim().slice(0, 100);
    const size = row.weight_g != null ? `${row.weight_g} جم` :
      row.volume_ml != null ? `${row.volume_ml} مل` : null;
    const pack = row.pack_count != null && Number(row.pack_count) > 0 ? `كرتونة ${row.pack_count} قطعة` : null;
    const unit = row.unit_price_type === "بالقطعة" ? "بالقطعة" : pack;
    const price = Number(row.package_sale_price).toFixed(2);
    const change = row.change_type === "price_change" || row.change_type === "price_and_weight_change"
      ? " • تغير سعر" : "";
    return `${index + 1}) ${name}${size ? ` — ${size}` : ""}\n   ${unit ? unit + " | " : ""}${price} ج.م${change}`;
  });
  const suffix = rows.length >= MAX_DIGEST_ROWS ? "\n\n(تم عرض أول 100 صنف في النشرة.)" : "";
  return [...header, "", ...lines, suffix].filter(Boolean).join("\n");
}

async function ensurePriceDigestSchema(pool) {
  if (!pool) throw new Error("price digest scheduler requires PostgreSQL");
  await pool.query(`CREATE TABLE IF NOT EXISTS price_digest_publications (
    id BIGSERIAL PRIMARY KEY,
    cairo_date DATE NOT NULL,
    slot_key TEXT NOT NULL CHECK (slot_key = 'daily'),
    chat_id BIGINT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared','published','failed')),
    message_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    last_error TEXT,
    UNIQUE(cairo_date, slot_key, chat_id)
  )`);
}

async function reservePriceDigest(pool, date, chatId) {
  const result = await pool.query(`INSERT INTO price_digest_publications(cairo_date,slot_key,chat_id,status)
    VALUES($1,'daily',$2,'prepared') ON CONFLICT(cairo_date,slot_key,chat_id) DO NOTHING RETURNING id`, [date, chatId]);
  return result.rows?.[0]?.id ?? null;
}

async function publishDailyPriceDigest({ pool, telegram, now = new Date(), onError = async () => {} }) {
  if (!pool || !telegram) return { skipped: true, reason: "database_or_telegram_missing" };
  const slot = currentPriceDigestSlot(now);
  if (!slot) return { skipped: true, reason: "outside_price_digest_window" };
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  let locked = false;
  try {
    if (typeof pool.connect === "function") {
      const lock = await client.query("SELECT pg_try_advisory_lock($1, $2) AS locked", [731942, 4]);
      locked = lock.rows?.[0]?.locked === true;
      if (!locked) return { skipped: true, reason: "price_digest_lock_busy" };
    }
    const groups = await client.query(`SELECT chat_id FROM authorized_chats
      WHERE active=TRUE AND chat_type IN ('group','supergroup') ORDER BY chat_id`);
    if (!groups.rows?.length) return { skipped: true, reason: "no_active_authorized_groups" };

    const handled = await client.query(`SELECT COUNT(*)::int AS handled_count
      FROM price_digest_publications
      WHERE cairo_date=$1 AND slot_key='daily' AND chat_id = ANY($2::bigint[])`,
      [slot.date, groups.rows.map(group => String(group.chat_id))]);
    if (Number(handled.rows?.[0]?.handled_count || 0) >= groups.rows.length) {
      return { skipped: true, reason: "all_groups_already_handled" };
    }

    const observations = await client.query(`SELECT DISTINCT ON (
        COALESCE(product_identity_key, product_text), weight_g, volume_ml,
        offer_extra_weight_g, package_type, package_sale_price
      ) product_text, package_sale_price, weight_g, volume_ml, pack_count,
        unit_price_type, change_type, observed_at
      FROM price_observations
      WHERE decision='accepted' AND price_kind='wholesale' AND confidence >= 0.8
        AND needs_review=FALSE AND package_sale_price > 0
        AND observed_at >= ($1::date::timestamp AT TIME ZONE 'Africa/Cairo')
        AND observed_at < (($1::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Cairo')
      ORDER BY COALESCE(product_identity_key, product_text), weight_g, volume_ml,
        offer_extra_weight_g, package_type, package_sale_price, observed_at DESC, id DESC
      LIMIT ${MAX_DIGEST_ROWS}`, [slot.date]);
    const message = formatDailyPriceDigest(observations.rows || [], slot.date);
    let sent = 0, failed = 0, alreadyHandled = 0;
    for (const group of groups.rows) {
      const chatId = String(group.chat_id);
      let id;
      try { id = await reservePriceDigest(client, slot.date, chatId); }
      catch (error) {
        failed++;
        await onError(error, { stage: "reserve", date: slot.date, chatId });
        continue;
      }
      if (!id) { alreadyHandled++; continue; }
      try {
        const result = await telegram.sendMessage(chatId, message, { disable_web_page_preview: true });
        await client.query("UPDATE price_digest_publications SET status='published',message_id=$2,published_at=NOW(),last_error=NULL WHERE id=$1", [id, result?.message_id || null]);
        sent++;
      } catch (error) {
        // Telegram may have accepted a message before the connection failed. Do not risk a duplicate resend.
        failed++;
        await client.query("UPDATE price_digest_publications SET status='failed',last_error=$2 WHERE id=$1", [id, String(error?.message || "telegram_send_failed").slice(0, 500)]).catch(() => {});
        await onError(error, { stage: "publish", date: slot.date, chatId });
      }
    }
    return { skipped: false, date: slot.date, rows: observations.rows?.length || 0, sent, failed, alreadyHandled };
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock($1, $2)", [731942, 4]); }
      catch (error) { await onError(error, { stage: "unlock" }); }
    }
    if (client !== pool) client.release();
  }
}

function startPriceDigestScheduler(options, { intervalMs = 30_000 } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await publishDailyPriceDigest(options); }
    catch (error) { await options.onError?.(error, { stage: "scheduler" }); }
    finally { running = false; }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = {
  CAIRO_ZONE, DAILY_HOUR, DAILY_MINUTE, GRACE_MINUTES, MAX_DIGEST_ROWS,
  currentPriceDigestSlot, formatDailyPriceDigest, ensurePriceDigestSchema,
  reservePriceDigest, publishDailyPriceDigest, startPriceDigestScheduler
};
