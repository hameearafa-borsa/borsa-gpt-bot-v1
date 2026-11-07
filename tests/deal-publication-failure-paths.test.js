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

function makePool({ failPublishedUpdate = false, failObservation = false, existingFailedReservation = false, existingPublishedReservation = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM service_settings")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT channel_kind,status")) {
        const rows = existingPublishedReservation
          ? [{ channel_kind: "amazon", status: "published", chat_id: -100123, item_count: 1 }]
          : existingFailedReservation ? [{ channel_kind: "amazon", status: "failed", chat_id: -100123, item_count: 1 }] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("WITH queued AS")) return { rows: [{ fingerprint: "fp-1" }], rowCount: 1 };
      if (sql.startsWith("INSERT INTO deal_publications")) { assert.ok(sql.includes("WHERE deal_publications.status='failed'"), "failed reservations must be reclaimed for retry"); return { rows: [{ id: 42 }], rowCount: 1 }; }
      if (sql.startsWith("UPDATE deal_publications SET status='published'")) {
        if (failPublishedUpdate) throw new Error("simulated publication record failure");
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE deal_publications SET status='failed'")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("INSERT INTO deal_observations")) {
        if (failObservation) throw new Error("simulated observation persistence failure");
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO deal_publication_queue")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM deal_publication_queue q")) {
        return { rows: candidates.map((deal, index) => ({
          ...deal, fingerprint: `fp-${index + 1}`, product_fingerprint: `product-${index + 1}`,
          first_queued_at: new Date("2026-10-01T00:00:00Z")
        })), rowCount: candidates.length };
      }
      if (sql.startsWith("UPDATE deal_publication_queue")) return { rows: [], rowCount: 1 };
      throw new Error("Unexpected SQL in test: " + sql);
    }
  };
}
(async () => {
  // Persistence must complete before any Telegram send. A confirmed send remains published
  // even if the batch-level publication record update subsequently fails.
  const recordPool = makePool({ failPublishedUpdate: true });
  const recordErrors = [];
  const recordResult = await publishDailyDeals({
    pool: recordPool,
    telegram: { sendMessage: async () => {
      recordPool.calls.push({ sql: "TELEGRAM_SEND" });
      return { message_id: 9001 };
    } },
    chatId: "-100123",
    fetcher: async () => ({ deals: candidates }),
    verify: async deals => deals,
    now: date,
    onError: async (_error, details) => recordErrors.push(details.stage)
  });
  assert.equal(recordResult.published.length, 1);
  assert.ok(recordErrors.includes("publication_record"));
  const observationIndex = recordPool.calls.findIndex(c => c.sql.startsWith("INSERT INTO deal_observations"));
  const queueIndex = recordPool.calls.findIndex(c => c.sql.startsWith("INSERT INTO deal_publication_queue"));
  const sendIndex = recordPool.calls.findIndex(c => c.sql === "TELEGRAM_SEND");
  assert.ok(observationIndex >= 0 && queueIndex > observationIndex && sendIndex > queueIndex,
    "observation and FIFO queue must be saved before Telegram is called");

  // If durable persistence fails, nothing is sent and the run remains retryable.
  const failedSavePool = makePool({ failObservation: true });
  const failedSaveErrors = [];
  let failedSaveSendCount = 0;
  const failedSave = await publishDailyDeals({
    pool: failedSavePool,
    telegram: { sendMessage: async () => { failedSaveSendCount++; return { message_id: 9002 }; } },
    chatId: "-100123",
    fetcher: async () => ({ deals: candidates }),
    verify: async deals => deals,
    now: date,
    onError: async (_error, details) => failedSaveErrors.push(details.stage)
  });
  assert.equal(failedSaveSendCount, 0, "do not publish an offer that failed durable persistence");
  assert.equal(failedSave.reason, "persist_failed");
  assert.ok(failedSaveErrors.includes("persist_deals"));

  // A later scheduled attempt must reclaim a failed batch reservation and deliver the still-queued item.
  const retryPool = makePool({ existingFailedReservation: true });
  let retrySendCount = 0;
  const retried = await publishDailyDeals({
    pool: retryPool,
    telegram: { sendMessage: async () => { retrySendCount++; return { message_id: 9050 }; } },
    chatId: "-100123",
    fetcher: async () => ({ deals: candidates }),
    verify: async deals => deals,
    now: date
  });
  assert.equal(retrySendCount, 1, "a failed reservation must not block the next publication attempt");
  assert.equal(retried.published.length, 1);

  // If Telegram succeeded and the publication record is durable but queue marking failed,
  // the next run reconciles the FIFO rows and must not send a duplicate newsletter.
  const reconcilePool = makePool({ existingPublishedReservation: true });
  let duplicateSendCount = 0;
  const reconciled = await publishDailyDeals({
    pool: reconcilePool,
    telegram: { sendMessage: async () => { duplicateSendCount++; return { message_id: 9051 }; } },
    chatId: "-100123",
    fetcher: async () => ({ deals: candidates }),
    verify: async deals => deals,
    now: date
  });
  assert.equal(duplicateSendCount, 0, "a confirmed published batch must not be sent again");
  assert.equal(reconciled.reason, "already_published");
  assert.ok(reconcilePool.calls.some(c => c.sql.startsWith("WITH queued AS") && c.sql.includes("SET status='published'")),
    "queued FIFO rows must be reconciled from the confirmed publication record");

  // A Telegram failure leaves the saved queue row queued; it is not deleted or expired.
  const sendFailurePool = makePool();
  const sendFailureErrors = [];
  const sendFailure = await publishDailyDeals({
    pool: sendFailurePool,
    telegram: { sendMessage: async () => {
      sendFailurePool.calls.push({ sql: "TELEGRAM_SEND" });
      throw new Error("simulated Telegram send failure");
    } },
    chatId: "-100123",
    fetcher: async () => ({ deals: candidates }),
    verify: async deals => deals,
    now: date,
    onError: async (_error, details) => sendFailureErrors.push(details.stage)
  });
  assert.equal(sendFailure.published.length, 0);
  assert.ok(sendFailureErrors.includes("publish"));
  assert.equal(sendFailurePool.calls.some(c => c.sql.startsWith("INSERT INTO deal_observations")), true);
  assert.equal(sendFailurePool.calls.some(c => c.sql.startsWith("INSERT INTO deal_publication_queue")), true);
  assert.equal(sendFailurePool.calls.some(c => c.sql.startsWith("UPDATE deal_publication_queue")), false,
    "failed sends must leave the queued offer untouched");

  // A multi-group run collects and persists once, queues independently, and sends FIFO to each group.
  const multiPool = makePool();
  const sentTo = [];
  let fetchCount = 0;
  const multi = await publishDailyDeals({
    pool: multiPool,
    telegram: { sendMessage: async (target) => {
      multiPool.calls.push({ sql: "TELEGRAM_SEND" });
      sentTo.push(Number(target));
      return { message_id: 9100 + sentTo.length };
    } },
    chatIds: [-100123, -100456],
    fetcher: async () => { fetchCount++; return { deals: candidates }; },
    verify: async deals => deals,
    now: date
  });
  assert.equal(fetchCount, 1);
  assert.deepEqual(sentTo, [-100123, -100456]);
  assert.equal(multi.published.length, 2);
  assert.equal(multiPool.calls.filter(c => c.sql.startsWith("INSERT INTO deal_observations")).length, 1,
    "observations should be persisted once, not once per group");
  assert.equal(multiPool.calls.filter(c => c.sql.startsWith("INSERT INTO deal_publication_queue")).length, 2,
    "each group should have its own durable queue entry");
  const queueUpsert = multiPool.calls.find(c => c.sql.startsWith("INSERT INTO deal_publication_queue"));
  assert.ok(queueUpsert.sql.includes("last_observed_at < NOW() - INTERVAL '7 days'"),
    "an identical offer absent for more than seven days may re-enter the queue");
  assert.ok(queueUpsert.sql.includes("last_observed_at >= NOW() - INTERVAL '7 days'"),
    "a recently published identical offer must remain suppressed to avoid daily repeats");
  assert.ok(queueUpsert.sql.includes("THEN NOW() ELSE deal_publication_queue.first_queued_at END"),
    "a re-queued offer starts a fresh FIFO position");
  const fifoRead = multiPool.calls.find(c => c.sql.includes("FROM deal_publication_queue q"));
  assert.ok(fifoRead?.sql.includes("ORDER BY q.first_queued_at ASC,q.fingerprint ASC"),
    "queued offers must be selected in stable FIFO order");
  assert.equal(multiPool.calls.filter(c => c.sql.includes("UPDATE deal_publication_queue") && c.sql.includes("SET status='published'")).length, 2,
    "queue entries become published only after successful Telegram sends");
  console.log("deal publication failure-path tests: OK");
})().catch(error => { console.error(error); process.exit(1); });
