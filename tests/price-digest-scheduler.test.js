"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DAILY_HOUR, DAILY_MINUTE, currentPriceDigestSlot, formatDailyPriceDigest,
  ensurePriceDigestSchema, publishDailyPriceDigest
} = require("../modules/price-digest-scheduler");

(async () => {
  const runtimeSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(runtimeSource, /ensurePriceDigestSchema\(db\.pool\)/,
    "the Telegram runtime must create the durable daily digest delivery ledger");
  assert.match(runtimeSource, /startPriceDigestScheduler\(/,
    "the Telegram runtime must start the evening price digest scheduler");
  assert.match(runtimeSource, /stopPriceDigest\(\)/,
    "shutdown must stop the daily price digest scheduler");
  const now = new Date("2026-11-02T18:02:00.000Z"); // 20:02 Africa/Cairo
  assert.equal(DAILY_HOUR, 20);
  assert.equal(DAILY_MINUTE, 0);
  assert.equal(currentPriceDigestSlot(new Date("2026-11-02T17:59:00.000Z")), null);
  assert.equal(currentPriceDigestSlot(now).date, "2026-11-02");
  assert.equal(currentPriceDigestSlot(new Date("2026-11-02T18:05:00.000Z")).date, "2026-11-02");
  assert.equal(currentPriceDigestSlot(new Date("2026-11-02T19:50:00.000Z")).date, "2026-11-02",
    "a restart after the five-minute opening window must still publish that day’s digest");
  assert.equal(currentPriceDigestSlot(new Date("2026-11-02T21:59:00.000Z")).date, "2026-11-02");
  assert.equal(currentPriceDigestSlot(new Date("2026-11-02T22:00:00.000Z")), null);

  const sampleRows = [
    { product_text: "دوف 350 مل", package_sale_price: 125, volume_ml: 350, pack_count: 12, unit_price_type: "بالكرتونة", change_type: "price_change" },
    { product_text: "صابون 60 جم", package_sale_price: 8.5, weight_g: 60, unit_price_type: "بالقطعة" }
  ];
  const formatted = formatDailyPriceDigest(sampleRows, "2026-11-02");
  assert.match(formatted, /نشرة رصد أسعار المنظفات اليومية/);
  assert.match(formatted, /دوف 350 مل/);
  assert.match(formatted, /125\.00 ج\.م/);
  assert.match(formatted, /تغير سعر/);
  assert.match(formatted, /صابون 60 جم/);
  assert.match(formatDailyPriceDigest([], "2026-11-02"), /لم تُسجل اليوم أسعار جملة مؤكدة/);

  const schemaCalls = [];
  await ensurePriceDigestSchema({ async query(sql) { schemaCalls.push(sql); return { rows: [] }; } });
  assert.match(schemaCalls[0], /CREATE TABLE IF NOT EXISTS price_digest_publications/);
  assert.match(schemaCalls[0], /UNIQUE\(cairo_date, slot_key, chat_id\)/);

  const sent = [];
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("SELECT chat_id FROM authorized_chats")) {
        return { rows: [{ chat_id: "-1001" }, { chat_id: "-1002" }] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS handled_count")) return { rows: [{ handled_count: 0 }] };
      if (sql.includes("SELECT DISTINCT ON")) return { rows: sampleRows };
      if (sql.includes("INSERT INTO price_digest_publications")) return { rows: [{ id: 70 }] };
      return { rows: [], rowCount: 1 };
    }
  };
  const result = await publishDailyPriceDigest({
    pool,
    telegram: { async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: 90 }; } },
    now
  });
  assert.equal(result.sent, 2);
  assert.equal(result.rows, 2);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(item => item.text === formatted));
  const observationQuery = queries.find(item => item.sql.includes("SELECT DISTINCT ON"));
  assert.match(observationQuery.sql, /decision='accepted'/);
  assert.match(observationQuery.sql, /price_kind='wholesale'/);
  assert.match(observationQuery.sql, /confidence >= 0\.8/);
  assert.match(observationQuery.sql, /needs_review=FALSE/);
  assert.match(observationQuery.sql, /AT TIME ZONE 'Africa\/Cairo'/);
  assert.match(observationQuery.sql, /unit_price_type, pack_count, package_sale_price/);
  assert.match(observationQuery.sql, /LIMIT 100/);
  assert.equal(observationQuery.params[0], "2026-11-02");

  let duplicateSends = 0;
  const duplicatePool = {
    async query(sql) {
      if (sql.includes("SELECT chat_id FROM authorized_chats")) return { rows: [{ chat_id: "-1001" }] };
      if (sql.includes("SELECT COUNT(*)::int AS handled_count")) return { rows: [{ handled_count: 1 }] };
      throw new Error("a completed daily digest must not query observations or send again");
    }
  };
  const duplicate = await publishDailyPriceDigest({
    pool: duplicatePool, telegram: { async sendMessage() { duplicateSends++; } }, now
  });
  assert.equal(duplicate.reason, "all_groups_already_handled");
  assert.equal(duplicateSends, 0);

  let outOfWindowQueries = 0;
  const outside = await publishDailyPriceDigest({
    pool: { async query() { outOfWindowQueries++; } },
    telegram: { async sendMessage() {} },
    now: new Date("2026-11-02T19:00:00.000Z")
  });
  assert.equal(outside.reason, "outside_price_digest_window");
  assert.equal(outOfWindowQueries, 0);

  console.log("daily price digest Cairo schedule, confirmed-only query, formatting, and duplicate-publication tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
