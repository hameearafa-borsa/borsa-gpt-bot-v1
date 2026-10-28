"use strict";

const https = require("node:https");
const { partsAt, dateKeyAt } = require("../core/cairo-time");

const CAIRO_ZONE = "Africa/Cairo";
const DAILY_HOUR = 10;
const DAILY_MINUTE = 30;
const GRACE_MINUTES = 5;
const FETCH_TIMEOUT_MS = 9000;
const MAX_RESPONSE_BYTES = 2_000_000;
const BRENT_URL = "https://query1.finance.yahoo.com/v8/finance/chart/BZ%3DF?range=5d&interval=1d";
const LOCAL_MARKET_URL = "https://ta3weem.com/ar";

function getText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || !["query1.finance.yahoo.com", "ta3weem.com"].includes(target.hostname)) {
      reject(new Error("economic_source_not_allowed"));
      return;
    }
    const req = https.get(target, {
      headers: { "user-agent": "Borsa-GPT-Bot/1.0", accept: "application/json,text/html" },
      timeout: timeoutMs
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) req.destroy(new Error("economic_response_too_large"));
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`economic_http_${response.statusCode}`));
          return;
        }
        resolve({ body, contentType: response.headers["content-type"] || "" });
      });
    });
    req.on("timeout", () => req.destroy(new Error("economic_source_timeout")));
    req.on("error", reject);
  });
}

function normalizeDigits(value) {
  return String(value).replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

function parsePositiveNumber(value) {
  const normalized = normalizeDigits(value).replace(/,/g, "").trim();
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function htmlToText(html) {
  return normalizeDigits(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(?:[0-9]+);/g, " "))
    .replace(/\s+/g, " ").trim();
}

function numberAfterLabel(text, labels, maxDistance = 16) {
  const haystack = text.toLowerCase();
  for (const label of labels) {
    const needle = label.toLowerCase();
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      const tail = text.slice(index + label.length, index + label.length + maxDistance);
      const match = tail.match(/^\s*(?:EGP|ج\.م|جنيه مصري|USD|\$)?\s*([0-9٠-٩۰-۹][0-9٠-٩۰-۹,.]*(?:\.[0-9٠-٩۰-۹]+)?)/i);
      const value = match && parsePositiveNumber(match[1]);
      if (value !== null && value !== undefined) return value;
      index = haystack.indexOf(needle, index + needle.length);
    }
  }
  return null;
}
function parseBrentPayload(payload, now = new Date()) {
  // Yahoo Finance's public chart endpoint provides the Brent futures quote (BZ=F)
  // and its exchange timestamp. Keep the older flat JSON shape parseable for
  // deterministic fixtures, but the live request uses Yahoo's chart response.
  const quote = payload?.chart?.result?.[0];
  if (payload?.chart && (!quote || payload.chart.error)) throw new Error("economic_brent_invalid_data");
  if (quote && (quote.meta?.currency !== "USD" || quote.meta?.symbol !== "BZ=F")) {
    throw new Error("economic_brent_invalid_data");
  }
  const price = Number(quote?.meta?.regularMarketPrice ?? payload?.price);
  const rawTimestamp = quote?.meta?.regularMarketTime;
  const timestamp = Number.isFinite(Number(rawTimestamp))
    ? Number(rawTimestamp) * 1000
    : Date.parse(payload?.timestamp || "");
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) throw new Error("economic_brent_invalid_data");
  // The feed is refreshed hourly; allow a weekend gap but never accept a clearly stale quote.
  if (timestamp > now.getTime() + 5 * 60_000 || now.getTime() - timestamp > 96 * 60 * 60_000) {
    throw new Error("economic_brent_stale_data");
  }
  return { price, timestamp: new Date(timestamp).toISOString() };
}

function parseLocalMarketHtml(html) {
  const text = htmlToText(html);
  const usd = numberAfterLabel(text, ["دولار أمريكي (USD)", "US Dollar (USD)", "USD-EGP", "الدولار الأمريكي"]);
  const gold21 = numberAfterLabel(text, ["ذهب عيار 21", "ذهب عيار 21", "21K Gold", "21K"]);
  const goldPound = numberAfterLabel(text, ["جنيه الذهب", "Gold Pound"]);
  if (![usd, gold21, goldPound].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("economic_local_market_data_incomplete");
  }
  // Ta3weem's homepage highlights local aggregated market rates, not a theoretical gold conversion.
  return { usdEgp: usd, gold21Egp: gold21, goldPoundEgp: goldPound };
}

function formatEconomicBulletin(prices) {
  const values = [prices?.brentUsd, prices?.usdEgp, prices?.goldPoundEgp, prices?.gold21Egp];
  if (!values.every(value => Number.isFinite(value) && value > 0)) throw new Error("economic_prices_invalid");
  const money = (value, digits = 2) => new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits, maximumFractionDigits: digits
  }).format(value);
  return [
    "🤖 الخدمة مقدمة بتقنيات GPT",
    `🛢️ خام برنت: ${money(prices.brentUsd)} دولار`,
    `💵 الدولار: ${money(prices.usdEgp, 2)} جنيه مصري`,
    `🪙 الجنيه الذهب: ${money(prices.goldPoundEgp, 0)} جنيه مصري`,
    `🥇 جرام الذهب عيار 21: ${money(prices.gold21Egp, 2)} جنيه مصري`
  ].join("\n");
}

async function getEconomicPrices({ now = new Date(), getTextImpl = getText } = {}) {
  const [brentResponse, localResponse] = await Promise.all([
    getTextImpl(BRENT_URL),
    getTextImpl(LOCAL_MARKET_URL)
  ]);
  let brentPayload;
  try { brentPayload = JSON.parse(brentResponse.body); }
  catch { throw new Error("economic_brent_invalid_json"); }
  const brent = parseBrentPayload(brentPayload, now);
  const local = parseLocalMarketHtml(localResponse.body);
  const prices = {
    brentUsd: brent.price,
    usdEgp: local.usdEgp,
    goldPoundEgp: local.goldPoundEgp,
    gold21Egp: local.gold21Egp
  };
  return { prices, message: formatEconomicBulletin(prices), measuredAt: brent.timestamp };
}

function currentEconomicSlot(now = new Date()) {
  const p = partsAt(new Date(now), CAIRO_ZONE);
  if (p.hour !== DAILY_HOUR || p.minute < DAILY_MINUTE || p.minute >= DAILY_MINUTE + GRACE_MINUTES) return null;
  return { date: dateKeyAt(now, CAIRO_ZONE), key: "daily", hour: p.hour, minute: p.minute };
}

async function ensureEconomicNewsletterSchema(pool) {
  if (!pool) throw new Error("economic scheduler requires PostgreSQL");
  await pool.query(`CREATE TABLE IF NOT EXISTS economic_publications (
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

async function reserveEconomicPublication(pool, date, chatId) {
  const result = await pool.query(`INSERT INTO economic_publications(cairo_date,slot_key,chat_id,status)
    VALUES($1,'daily',$2,'prepared') ON CONFLICT(cairo_date,slot_key,chat_id) DO NOTHING RETURNING id`, [date, chatId]);
  return result.rows?.[0]?.id ?? null;
}

async function publishEconomicSlot({ pool, telegram, now = new Date(), getPrices = getEconomicPrices, onError = async () => {} }) {
  if (!pool || !telegram) return { skipped: true, reason: "database_or_telegram_missing" };
  const slot = currentEconomicSlot(now);
  if (!slot) return { skipped: true, reason: "outside_economic_window" };
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  let locked = false;
  try {
    if (typeof pool.connect === "function") {
      const lock = await client.query("SELECT pg_try_advisory_lock($1, $2) AS locked", [731942, 3]);
      locked = lock.rows?.[0]?.locked === true;
      if (!locked) return { skipped: true, reason: "economic_lock_busy" };
    }
    const groups = await client.query(`SELECT chat_id FROM authorized_chats
      WHERE active=TRUE AND chat_type IN ('group','supergroup') ORDER BY chat_id`);
    if (!groups.rows?.length) return { skipped: true, reason: "no_active_authorized_groups" };

    // A second Railway instance can enter the same time window after the first
    // instance has already published. Check the durable per-group reservations
    // before making paid/slow external requests, so an already-completed slot
    // does not emit a misleading source-timeout diagnostic.
    const handled = await client.query(`SELECT COUNT(*)::int AS handled_count
      FROM economic_publications
      WHERE cairo_date=$1 AND slot_key='daily' AND chat_id = ANY($2::bigint[])`,
      [slot.date, groups.rows.map(group => String(group.chat_id))]);
    if (Number(handled.rows?.[0]?.handled_count || 0) >= groups.rows.length) {
      return { skipped: true, reason: "all_groups_already_handled" };
    }

    let report;
    try { report = await getPrices({ now }); }
    catch (error) {
      await onError(error, { stage: "fetch", date: slot.date });
      return { skipped: true, reason: "economic_data_incomplete" };
    }
    let sent = 0, failed = 0, alreadyHandled = 0;
    for (const group of groups.rows) {
      const chatId = String(group.chat_id);
      let id;
      try { id = await reserveEconomicPublication(client, slot.date, chatId); }
      catch (error) {
        failed++;
        await onError(error, { stage: "reserve", date: slot.date, chatId });
        continue;
      }
      if (!id) { alreadyHandled++; continue; }
      try {
        const message = await telegram.sendMessage(chatId, report.message, { disable_web_page_preview: true });
        await client.query("UPDATE economic_publications SET status='published',message_id=$2,published_at=NOW(),last_error=NULL WHERE id=$1", [id, message?.message_id || null]);
        sent++;
      } catch (error) {
        // Telegram's error may arrive after delivery; do not automatically resend an ambiguous publication.
        failed++;
        await client.query("UPDATE economic_publications SET status='failed',last_error=$2 WHERE id=$1", [id, String(error?.message || "telegram_send_failed").slice(0, 500)]).catch(() => {});
        await onError(error, { stage: "publish", date: slot.date, chatId });
      }
    }
    return { skipped: false, date: slot.date, sent, failed, alreadyHandled };
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock($1, $2)", [731942, 3]); }
      catch (error) { await onError(error, { stage: "unlock" }); }
    }
    if (client !== pool) client.release();
  }
}

function startEconomicNewsletterScheduler(options, { intervalMs = 30_000 } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await publishEconomicSlot(options); }
    catch (error) { await options.onError?.(error, { stage: "scheduler" }); }
    finally { running = false; }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = {
  CAIRO_ZONE, DAILY_HOUR, DAILY_MINUTE, GRACE_MINUTES, BRENT_URL, LOCAL_MARKET_URL,
  normalizeDigits, parsePositiveNumber, htmlToText, numberAfterLabel, parseBrentPayload,
  parseLocalMarketHtml, formatEconomicBulletin, getEconomicPrices, currentEconomicSlot,
  ensureEconomicNewsletterSchema, reserveEconomicPublication, publishEconomicSlot, startEconomicNewsletterScheduler
};
