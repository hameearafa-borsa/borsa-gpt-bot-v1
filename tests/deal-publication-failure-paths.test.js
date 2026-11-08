"use strict";
const assert = require("node:assert/strict");
const { publishDailyDeals, enqueueObservedDeals } = require("../modules/deal-scheduler");
const { dealFingerprint, dealProductFingerprint } = require("../modules/deals");

const date = new Date("2026-10-12T13:00:00.000Z"); // 4 PM in Cairo
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

function makePool({ failPublishedUpdate = false, failObservation = false, failQueuePublished = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM service_settings")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT channel_kind,status")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("INSERT INTO deal_observations")) {
        if (failObservation) throw new Error("simulated observation persistence failure");
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO deal_publication_queue")) return { rows: [{ fingerprint: params[0], status: "queued" }], rowCount: 1 };
      if (sql.startsWith("UPDATE deal_publication_queue")) {
        if (params[1] === "published" && failQueuePublished) throw new Error("simulated queue status failure");
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("SELECT o.merchant")) return {
        rows: candidates.map(deal => ({ ...deal, fingerprint: dealFingerprint(deal), product_fingerprint: dealProductFingerprint(deal) })),
        rowCount: candidates.length
      };
      if (sql.startsWith("INSERT INTO deal_publications")) return { rows: [{ id: 42 }], rowCount: 1 };
      if (sql.startsWith("UPDATE deal_publications SET status='published'")) {
        if (failPublishedUpdate) throw new Error("simulated publication record failure");
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE deal_publications SET status='failed'")) return { rows: [], rowCount: 1 };
      throw new Error("Unexpected SQL in test: " + sql);
    }
  };
}

(async () => {
  // Several price candidates for the same ASIN retain all observations but
  // queue only the strongest current offer for each destination group.
  const rankedQueueCalls = [];
  const rankedPool = {
    async query(sql, params = []) {
      if (sql.startsWith("INSERT INTO deal_observations")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("UPDATE deal_publication_queue")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("INSERT INTO deal_publication_queue")) {
        rankedQueueCalls.push(params);
        return { rows: [{ fingerprint: params[0], status: "queued" }], rowCount: 1 };
      }
      throw new Error("Unexpected SQL in ranked queue test: " + sql);
    }
  };
  const sameProductCandidates = [
    { ...candidates[0], price: 110, discount_pct: 8 },
    { ...candidates[0], price: 90, discount_pct: 25 }
  ];
  const rankedResult = await enqueueObservedDeals(rankedPool, sameProductCandidates, "amazon", [-100123]);
  assert.equal(rankedResult.saved, 2, "all valid price observations remain stored");
  assert.equal(rankedQueueCalls.length, 1, "only one current candidate per product enters the queue");
  assert.equal(rankedQueueCalls[0][0], dealFingerprint(sameProductCandidates[1]),
    "the strongest discount candidate should be queued");

  // Confirmed Telegram send followed by DB failure must not mark the post failed.
  for (const failure of ["publication_record", "update_deal_queue"]) {
    const pool = makePool({
      failPublishedUpdate: failure === "publication_record",
      failQueuePublished: failure === "update_deal_queue"
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

  // A send failure is recorded, but the observed offer remains durably queued for a later run.
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
  assert.equal(pool.calls.some(c => c.sql.startsWith("INSERT INTO deal_observations")), true,
    "observation must be saved before attempting publication");
  assert.equal(pool.calls.some(c => c.sql.startsWith("UPDATE deal_publication_queue") && c.params[1] === "published"), false,
    "a failed Telegram send must leave the queue item pending");

  // The same pending offer can be published in the next day's edition even if
  // the fresh Amazon search returns nothing.
  let retryFetchCount = 0;
  let retrySendCount = 0;
  const retry = await publishDailyDeals({
    pool,
    telegram: { sendMessage: async () => { retrySendCount++; return { message_id: 9002 }; } },
    chatId: "-100123",
    fetcher: async () => { retryFetchCount++; return { deals: [] }; },
    verify: async deals => deals,
    now: new Date("2026-10-13T13:00:00.000Z")
  });
  assert.equal(retryFetchCount, 1);
  assert.equal(retrySendCount, 1, "a pending queued offer must be published on a later edition");
  assert.equal(retry.published.length, 1);
  assert.equal(retry.published[0].messageId, 9002);

  // If observation persistence fails, do not send an offer that cannot be recovered.
  const persistenceFailurePool = makePool({ failObservation: true });
  let persistenceFailureSendCount = 0;
  await assert.rejects(() => publishDailyDeals({
    pool: persistenceFailurePool,
    telegram: { sendMessage: async () => { persistenceFailureSendCount++; return { message_id: 9050 }; } },
    chatId: "-100123",
    fetcher: async () => ({ deals: candidates }),
    verify: async deals => deals,
    now: date
  }), /simulated observation persistence failure/);
  assert.equal(persistenceFailureSendCount, 0,
    "publication must not proceed when the observed offer could not be durably saved");

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
  assert.equal(multiPool.calls.filter(c => c.sql.startsWith("INSERT INTO deal_publication_queue")).length, 2,
    "each pending offer must have an independent queue row for every target group");
  assert.ok(multiPool.calls.some(c => c.sql.includes("old.product_fingerprint=$3") && c.sql.includes("q.chat_id=$2")),
    "a changed product offer must expire its older pending price in that group");

  // A partial multi-group send must complete only the successful group's queue.
  const partialPool = makePool();
  const partialSent = [];
  await publishDailyDeals({
    pool: partialPool,
    telegram: { sendMessage: async target => {
      partialSent.push(Number(target));
      if (Number(target) === -100456) throw new Error("second group unavailable");
      return { message_id: 9201 };
    } },
    chatIds: [-100123, -100456],
    fetcher: async () => ({ deals: candidates }),
    verify: async deals => deals,
    now: date
  });
  const completedChats = partialPool.calls
    .filter(c => c.sql.startsWith("UPDATE deal_publication_queue") && c.params[1] === "published")
    .map(c => c.params[2]);
  assert.deepEqual(partialSent, [-100123, -100456]);
  assert.deepEqual(completedChats, [-100123],
    "one group's success must not mark the other group's pending offer as published");

  console.log("deal publication failure-path tests: OK");
})().catch(error => { console.error(error); process.exit(1); });
