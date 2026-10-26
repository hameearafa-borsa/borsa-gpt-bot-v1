"use strict";
const assert = require("node:assert/strict");
const { publishDailyDeals } = require("../modules/deal-scheduler");

const date = new Date("2026-10-12T14:00:00.000Z"); // 5 PM in Cairo
const candidates = [{
  merchant: "Amazon.eg",
  title: "مسحوق غسيل اختبار",
  url: "https://www.amazon.eg/dp/B0ABCDEF12",
  price: 100,
  old_price: 120,
  discount_pct: 16,
  category: "detergent",
  verified_url: true
}];

function makePool({ failPublishedUpdate = false, failObservation = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT channel_kind,status")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT 1 FROM deal_observations")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("INSERT INTO deal_publications")) return { rows: [{ id: 42 }], rowCount: 1 };
      if (sql.startsWith("UPDATE deal_publications SET status='published'")) {
        if (failPublishedUpdate) throw new Error("simulated publication record failure");
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE deal_publications SET status='failed'")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("INSERT INTO deal_observations")) {
        if (failObservation) throw new Error("simulated observation persistence failure");
        return { rows: [], rowCount: 1 };
      }
      throw new Error("Unexpected SQL in test: " + sql);
    }
  };
}

(async () => {
  // Confirmed Telegram send followed by DB failure must not mark the post failed.
  for (const failure of ["publication_record", "persist_deals"]) {
    const pool = makePool({
      failPublishedUpdate: failure === "publication_record",
      failObservation: failure === "persist_deals"
    });
    const errors = [];
    let sendCount = 0;
    const result = await publishDailyDeals({
      pool,
      telegram: { sendMessage: async () => { sendCount++; return { message_id: 9001 }; } },
      chatId: "-100123",
      fetcher: async () => ({ deals: candidates }),
      verify: async deals => deals,
      now: date,
      onError: async (_error, details) => errors.push(details.stage)
    });
    assert.equal(sendCount, 1, "Telegram should be called once");
    assert.equal(result.published.length, 1, "confirmed send should remain reported as published");
    assert.equal(result.published[0].messageId, 9001);
    assert.ok(errors.includes(failure), "post-send failure should be reported with its own stage");
    assert.equal(pool.calls.some(c => c.sql.startsWith("UPDATE deal_publications SET status='failed'")), false,
      "post-send database failures must never downgrade a sent message to failed");
  }

  // A send failure is still recorded as failed and does not persist observations.
  const pool = makePool();
  const errors = [];
  const result = await publishDailyDeals({
    pool,
    telegram: { sendMessage: async () => { throw new Error("simulated Telegram send failure"); } },
    chatId: "-100123",
    fetcher: async () => ({ deals: candidates }),
    verify: async deals => deals,
    now: date,
    onError: async (_error, details) => errors.push(details.stage)
  });
  assert.equal(result.published.length, 0);
  assert.ok(errors.includes("publish"));
  assert.equal(pool.calls.some(c => c.sql.startsWith("UPDATE deal_publications SET status='failed'")), true);
  assert.equal(pool.calls.some(c => c.sql.startsWith("INSERT INTO deal_observations")), false);

  // A multi-group run must gather candidates once and send once to each group.
  const multiPool = makePool();
  const sentTo = [];
  let fetchCount = 0;
  const multi = await publishDailyDeals({
    pool: multiPool,
    telegram: { sendMessage: async (target, _message) => { sentTo.push(Number(target)); return { message_id: 9100 + sentTo.length }; } },
    chatIds: [-100123, -100456],
    fetcher: async () => { fetchCount++; return { deals: candidates }; },
    verify: async deals => deals,
    now: date
  });
  assert.equal(fetchCount, 1, "candidate collection should happen once for all groups");
  assert.deepEqual(sentTo, [-100123, -100456]);
  assert.equal(multi.published.length, 2, "both approved groups should receive the newsletter");
  assert.equal(multiPool.calls.filter(c => c.sql.startsWith("INSERT INTO deal_observations")).length, 1,
    "observed offers should be persisted once, not once per group");

  console.log("deal publication failure-path tests: OK");
})().catch(error => { console.error(error); process.exit(1); });
