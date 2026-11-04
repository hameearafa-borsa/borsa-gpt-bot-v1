"use strict";
const assert = require("node:assert/strict");
const {
  PRAYERS, GRACE_MINUTES, parsePrayerTime, parseOfficialPrayerTimes,
  currentPrayerSlot, formatPrayerAlert, publishPrayerSlot
} = require("../modules/prayer-alert-scheduler");

(async () => {
  assert.deepEqual(parsePrayerTime("4:42 ص"), { hour: 4, minute: 42, text: "04:42" });
  assert.deepEqual(parsePrayerTime("12:05 ص"), { hour: 0, minute: 5, text: "00:05" });
  assert.deepEqual(parsePrayerTime("12:15 م"), { hour: 12, minute: 15, text: "12:15" });
  assert.deepEqual(parsePrayerTime("5:06 م"), { hour: 17, minute: 6, text: "17:06" });
  assert.equal(parsePrayerTime("25:90 م"), null);
  assert.equal(PRAYERS.length, 5);
  assert.equal(GRACE_MINUTES, 2);

  const html = `<table><tr><th>المدينة</th><th>التاريخ الميلادي</th><th>الهجري</th><th>فجر</th><th>شروق</th><th>ظهر</th><th>عصر</th><th>مغرب</th><th>عشاء</th></tr>
  <tr><td>القاهرة</td><td>2026-11-03</td><td>23 جماد الأول</td><td>4:42 ص</td><td>6:10 ص</td><td>11:38 ص</td><td>2:44 م</td><td>5:6 م</td><td>6:25 م</td></tr>
  <tr><td>الإسكندرية</td><td>2026-11-03</td><td>23 جماد الأول</td><td>4:48 ص</td><td>6:17 ص</td><td>11:44 ص</td><td>2:47 م</td><td>5:10 م</td><td>6:30 م</td></tr></table>`;
  const schedule = parseOfficialPrayerTimes(html, "2026-11-03");
  assert.equal(schedule.city, "القاهرة");
  assert.equal(schedule.times.maghrib.text, "17:06");
  assert.equal(schedule.times.fajr.text, "04:42");
  assert.throws(() => parseOfficialPrayerTimes(html, "2026-11-04"), /not_found/);
  assert.throws(() => parseOfficialPrayerTimes(html.replace("5:6 م", "غير متاح"), "2026-11-03"), /invalid_maghrib/);

  const maghribNow = new Date("2026-11-03T15:06:30.000Z"); // 17:06:30 Cairo
  const slot = currentPrayerSlot(schedule, maghribNow);
  assert.deepEqual(slot, { date: "2026-11-03", prayer: "maghrib", label: "المغرب", time: "17:06" });
  assert.equal(currentPrayerSlot(schedule, new Date("2026-11-03T15:08:00.000Z")), null);
  assert.equal(currentPrayerSlot(schedule, new Date("2026-11-03T15:05:00.000Z")), null);
  const alertText = formatPrayerAlert(slot);
  assert.equal(alertText, "🕌 حان الآن موعد أذان المغرب\n\n🕰️ 17:06 بتوقيت القاهرة\n\nنسأل الله أن يتقبل منكم صالح الأعمال.\n\nقوموا إلى صلاتكم يرحمنا ويرحمكم الله");
  assert.ok(!alertText.includes("المصدر"));
  assert.ok(!alertText.includes("الهيئة المصرية العامة للمساحة"));

  const sent = [];
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push(sql);
      if (sql.includes("FROM service_settings")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM authorized_chats")) return { rows: [{ chat_id: "-1001" }, { chat_id: "-1002" }], rowCount: 2 };
      if (sql.includes("INSERT INTO prayer_alert_publications")) return { rows: [{ id: sent.length + 1 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }
  };
  const result = await publishPrayerSlot({
    pool,
    telegram: { async sendMessage(chatId, message) { sent.push({ chatId, message }); return { message_id: 88 }; } },
    now: maghribNow,
    getTimes: async () => schedule
  });
  assert.equal(result.sent, 2);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(item => item.message.includes("أذان المغرب")));
  assert.ok(queries.some(sql => sql.includes("INSERT INTO prayer_alert_publications")));

  let calls = 0;
  const disabledPool = {
    async query(sql) {
      if (sql.includes("FROM service_settings")) return { rows: [{ scope: "global", enabled: false }], rowCount: 1 };
      if (sql.includes("FROM authorized_chats")) return { rows: [{ chat_id: "-1001" }], rowCount: 1 };
      throw new Error("disabled prayer service must not reserve");
    }
  };
  const disabled = await publishPrayerSlot({
    pool: disabledPool, telegram: { async sendMessage() { calls++; } },
    now: maghribNow, getTimes: async () => schedule
  });
  assert.equal(disabled.sent, 0);
  assert.equal(calls, 0);

  console.log("official Cairo prayer parsing, five-prayer schedule, and durable publication tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
