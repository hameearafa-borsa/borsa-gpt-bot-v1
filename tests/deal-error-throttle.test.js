"use strict";
const assert = require("node:assert/strict");
const { publishDailyDeals } = require("../modules/deal-scheduler");

(async () => {
  let notifications = 0;
  let notificationWrites = 0;
  const pool = {
    async query(sql) {
      if (sql.includes("SELECT channel_kind,status FROM deal_publications")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO deal_error_notifications")) {
        notificationWrites++;
        return { rows: [{ should_notify: notificationWrites === 1 }], rowCount: 1 };
      }
      throw new Error("Unexpected SQL in deal alert throttle test");
    }
  };
  const options = {
    pool,
    telegram: { sendMessage: async () => { throw new Error("Must not publish when no deals exist"); } },
    chatId: -100123,
    now: new Date("2026-10-12T15:00:00.000Z"),
    fetcher: async () => ({ deals: [], errors: [{ source: "amazon", status: "http_403" }] }),
    onError: async () => { notifications++; }
  };
  const first = await publishDailyDeals(options);
  const second = await publishDailyDeals(options);
  assert.equal(first.reason, "no_deals");
  assert.equal(first.notified, true);
  assert.equal(second.reason, "no_deals");
  assert.equal(second.notified, false);
  assert.equal(notificationWrites, 2);
  assert.equal(notifications, 1, "same failure should alert once during the throttle window");
  console.log("deal error notification throttle tests: OK");
})().catch(error => { console.error(error); process.exit(1); });
