"use strict";
const assert = require("node:assert/strict");
const {
  parseBrentPayload, parseLocalMarketHtml, formatEconomicBulletin,
  currentEconomicSlot, GRACE_MINUTES, publishEconomicSlot
} = require("../modules/economic-newsletter");

(async () => {
  const now = new Date("2026-10-26T07:31:00.000Z"); // 10:31 Africa/Cairo
  const brent = parseBrentPayload({ price: 88.13, timestamp: "2026-10-26T07:00:00.000Z" }, now);
  assert.equal(brent.price, 88.13);
  assert.throws(() => parseBrentPayload({ price: 88.13, timestamp: "2026-10-20T07:00:00.000Z" }, now), /stale/);
  assert.throws(() => parseBrentPayload({ price: 0, timestamp: "2026-10-26T07:00:00.000Z" }, now), /invalid/);

  const html = `<html><body>
    <div>دولار أمريكي (USD)</div><strong>56.25</strong>
    <div>ذهب عيار 21</div><strong>6,305.00</strong>
    <div>جنيه الذهب</div><strong>50,468</strong>
  </body></html>`;
  assert.deepEqual(parseLocalMarketHtml(html), { usdEgp: 56.25, gold21Egp: 6305, goldPoundEgp: 50468 });
  assert.throws(() => parseLocalMarketHtml("<html>لا توجد أسعار</html>"), /incomplete/);

  const message = formatEconomicBulletin({ brentUsd: 88.13, usdEgp: 56.25, goldPoundEgp: 50468, gold21Egp: 6305 });
  assert.equal(message.split("\n").length, 4);
  assert.ok(message.includes("خام برنت"));
  assert.ok(message.includes("الدولار"));
  assert.ok(message.includes("الجنيه الذهب"));
  assert.ok(message.includes("عيار 21"));
  assert.ok(!message.includes("http"));
  assert.throws(() => formatEconomicBulletin({ brentUsd: 88.13, usdEgp: 0, goldPoundEgp: 50468, gold21Egp: 6305 }), /invalid/);

  assert.equal(currentEconomicSlot(new Date("2026-10-26T07:29:00.000Z")), null);
  assert.equal(currentEconomicSlot(now).key, "daily");
  assert.equal(currentEconomicSlot(new Date("2026-10-26T07:34:00.000Z")).key, "daily");
  assert.equal(currentEconomicSlot(new Date("2026-10-26T07:35:00.000Z")), null);
  assert.equal(GRACE_MINUTES, 5);

  const sent = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes("SELECT chat_id FROM authorized_chats")) return { rows: [{ chat_id: "-1001" }, { chat_id: "-1002" }], rowCount: 2 };
      if (sql.includes("INSERT INTO economic_publications")) return { rows: [{ id: 12 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }
  };
  const result = await publishEconomicSlot({
    pool, telegram: { async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: 44 }; } },
    now, getPrices: async () => ({ message })
  });
  assert.equal(result.sent, 2);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(item => item.text === message));

  let partialSends = 0;
  const incomplete = await publishEconomicSlot({
    pool, telegram: { async sendMessage() { partialSends++; } }, now,
    getPrices: async () => { throw new Error("one source unavailable"); }
  });
  assert.equal(incomplete.reason, "economic_data_incomplete");
  assert.equal(partialSends, 0);

  console.log("economic newsletter parsing, format, schedule, and publication tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
