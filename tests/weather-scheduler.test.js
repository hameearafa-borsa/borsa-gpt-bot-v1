"use strict";
const assert = require("node:assert/strict");
const { currentWeatherSlot, GRACE_MINUTES, publishWeatherSlot } = require("../modules/weather-scheduler");
const { getDailyWeatherReport, EGYPT_CITIES } = require("../modules/weather");

function utcForCairo(value) {
  const [date,time] = value.split("T");
  // These dates use Cairo UTC+3 in the test range (October 2026).
  return new Date(`${date}T${String(Number(time.slice(0,2))-3).padStart(2,"0")}:${time.slice(3)}:00Z`);
}
function fakeForecast(url) {
  const index = EGYPT_CITIES.findIndex(c => url.includes(`latitude=${c.latitude}`));
  const c = EGYPT_CITIES[index < 0 ? 0 : index];
  return {
    timezone: "Africa/Cairo",
    current: { temperature_2m: 27 + index, relative_humidity_2m: 45, apparent_temperature: 29 + index, wind_speed_10m: 12, precipitation: 0, weather_code: 1, time: "2026-10-24T11:00" }
  };
}

(async () => {
  assert.equal(currentWeatherSlot(utcForCairo("2026-10-24T10:59")), null);
  assert.equal(currentWeatherSlot(utcForCairo("2026-10-24T11:00")).key, "11");
  assert.equal(currentWeatherSlot(utcForCairo("2026-10-24T11:04")).key, "11");
  assert.equal(currentWeatherSlot(utcForCairo("2026-10-24T11:05")), null);
  assert.equal(currentWeatherSlot(utcForCairo("2026-10-24T20:02")).key, "20");
  assert.equal(GRACE_MINUTES, 5);

  const report = await getDailyWeatherReport({ now: utcForCairo("2026-10-24T11:00"), fetchJson: async url => fakeForecast(url) });
  assert.equal(report.cities.length, 4);
  for (const city of ["الإسكندرية", "القاهرة", "المنيا", "الأقصر"]) assert.ok(report.message.includes(city));
  assert.ok(!report.message.includes("https://"));
  assert.ok(!report.message.includes("📍"), "the bulletin must not use the red location pin");
  assert.ok(report.message.includes("🌤️ الإسكندرية"), "city headings should use the matching weather icon");
  await assert.rejects(() => getDailyWeatherReport({
    fetchJson: async url => {
      if (url.includes("latitude=25.6872")) return { timezone: "Africa/Cairo", current: { temperature_2m: null } };
      return fakeForecast(url);
    }
  }), /weather_invalid_or_incomplete_data/);

  const calls = [];
  const db = { async query(sql, params) {
    calls.push({sql,params});
    if (sql.includes("SELECT chat_id FROM authorized_chats")) return { rows: [{chat_id:"-100123"},{chat_id:"-100456"}], rowCount:2 };
    if (sql.includes("INSERT INTO weather_publications")) return { rows: [{id: calls.length}], rowCount:1 };
    if (sql.includes("UPDATE weather_publications SET status='published'")) return { rows: [], rowCount:1 };
    return { rows: [], rowCount:1 };
  }};
  const sent = [];
  const result = await publishWeatherSlot({
    pool: db, telegram: { async sendMessage(chatId, message) { sent.push({chatId,message}); return {message_id:77}; } },
    now: utcForCairo("2026-10-24T11:01"),
    getReport: async () => ({ message: "complete weather bulletin" })
  });
  assert.equal(result.sent, 2);
  assert.deepEqual(sent.map(x => x.chatId), ["-100123","-100456"]);
  assert.ok(sent.every(x => x.message === "complete weather bulletin"));

  // A Telegram error can be ambiguous: it may occur after the message was accepted.
  // The durable reservation must prevent a second send during the same grace window.
  const reservations = new Map();
  const ambiguousCalls = [];
  let nextReservationId = 1;
  const ambiguousDb = { async query(sql, params = []) {
    ambiguousCalls.push({ sql, params });
    if (sql.includes("SELECT chat_id FROM authorized_chats")) return { rows: [{ chat_id: "-100789" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO weather_publications")) {
      const key = params.join("|");
      if (reservations.has(key)) return { rows: [], rowCount: 0 };
      const row = { id: nextReservationId++, status: "prepared" };
      reservations.set(key, row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE weather_publications SET status='failed'")) {
      const row = [...reservations.values()].find(item => item.id === params[0]);
      if (row) row.status = "failed";
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE weather_publications SET status='published'")) {
      const row = [...reservations.values()].find(item => item.id === params[0]);
      if (row) row.status = "published";
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  }};
  let ambiguousSendCount = 0;
  const ambiguousTelegram = { async sendMessage() {
    ambiguousSendCount++;
    throw new Error("connection closed after request; delivery unknown");
  }};
  const ambiguousOptions = {
    pool: ambiguousDb, telegram: ambiguousTelegram, now: utcForCairo("2026-10-24T11:01"),
    getReport: async () => ({ message: "complete weather bulletin" })
  };
  const ambiguousFirst = await publishWeatherSlot(ambiguousOptions);
  const ambiguousSecond = await publishWeatherSlot(ambiguousOptions);
  assert.equal(ambiguousFirst.failed, 1);
  assert.equal(ambiguousSecond.alreadyHandled, 1);
  assert.equal(ambiguousSendCount, 1, "ambiguous send failures must not be automatically retried");
  assert.equal(ambiguousCalls.some(call => call.sql.startsWith("UPDATE weather_publications SET status='prepared'")), false);

  console.log("weather schedule, complete bulletin, and ambiguous-send deduplication tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
