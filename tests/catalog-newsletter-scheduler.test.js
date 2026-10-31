"use strict";
const assert = require("node:assert/strict");
const { DAILY_HOUR, DAILY_MINUTE, cairoClock, msUntilNextCheck, fetchStorePage, checkCatalogsOnce } = require("../modules/catalog-newsletter-scheduler");
const { newsletterKindAt } = require("../modules/deal-scheduler");
const { currentWeatherSlot } = require("../modules/weather-scheduler");

assert.equal(DAILY_HOUR, 10);
assert.equal(DAILY_MINUTE, 10);
assert.equal(typeof cairoClock().hour, "number");

// Catalog check has a 50-minute buffer before the existing 11:00 weather bulletin,
// and is many hours away from the 17:00/18:00 deal newsletters.
assert.equal(currentWeatherSlot(new Date("2026-10-25T07:10:00.000Z")), null); // 10:10 Cairo
assert.equal(currentWeatherSlot(new Date("2026-10-25T08:00:00.000Z"))?.hour, 11); // 11:00 Cairo
assert.equal(newsletterKindAt(new Date("2026-10-25T07:10:00.000Z")), null); // 10:10 Cairo
assert.equal(newsletterKindAt(new Date("2026-10-25T14:00:00.000Z")), "amazon"); // 17:00 Cairo
assert.equal(newsletterKindAt(new Date("2026-10-25T15:00:00.000Z")), "other_sites"); // 18:00 Cairo

const before = new Date("2026-10-25T07:09:00.000Z"); // 10:09 Cairo
assert.equal(msUntilNextCheck(before), 60 * 1000);
const after = new Date("2026-10-25T07:11:00.000Z"); // 10:11 Cairo
assert.equal(msUntilNextCheck(after), 24 * 60 * 60 * 1000 - 60 * 1000);

// Egypt leaves daylight-saving time overnight on 29/30 October 2026.
// The next local 10:10 is 24h59m later, not 23h59m later.
const beforeCairoDstEnds = new Date("2026-10-29T07:11:00.000Z"); // 10:11 EEST
assert.equal(msUntilNextCheck(beforeCairoDstEnds), 24 * 60 * 60 * 1000 + 59 * 60 * 1000);
const atNextCairoCheck = new Date("2026-10-30T08:10:00.000Z"); // 10:10 EET
assert.equal(msUntilNextCheck(atNextCairoCheck), 24 * 60 * 60 * 1000);

(async () => {
  await assert.rejects(() => fetchStorePage("https://evil.example/"), /catalog_source_not_allowed/);
  await assert.rejects(() => fetchStorePage("https://snapflyer.io:8443/"), /catalog_source_not_allowed/);
  await assert.rejects(() => fetchStorePage("https://user:pass@snapflyer.io/"), /catalog_source_not_allowed/);
  const html = await fetchStorePage("https://snapflyer.io/eg/downtown/stores/kazyon", {
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => "<html>ok</html>" })
  });
  assert.equal(html, "<html>ok</html>");
  let timeoutSignalObserved = false;
  await assert.rejects(() => fetchStorePage("https://snapflyer.io/eg/downtown/stores/kazyon", {
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        timeoutSignalObserved = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    })
  }), /aborted/);
  assert.equal(timeoutSignalObserved, true, "catalog fetch must abort when its timeout expires");
  let oversizedBodyRead = false;
  await assert.rejects(() => fetchStorePage("https://snapflyer.io/eg/downtown/stores/kazyon", {
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: name => name === "content-type" ? "text/html" : name === "content-length" ? "2000001" : null },
      text: async () => { oversizedBodyRead = true; return "<html>too large</html>"; }
    })
  }), /catalog_html_empty_or_too_large/);
  assert.equal(oversizedBodyRead, false, "reject oversized declared bodies before buffering the response");
  let streamedBodyCancelled = false;
  await assert.rejects(() => fetchStorePage("https://snapflyer.io/eg/downtown/stores/kazyon", {
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: name => name === "content-type" ? "text/html" : null },
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(2_000_001) }),
          cancel: async () => { streamedBodyCancelled = true; },
          releaseLock: () => {}
        })
      }
    })
  }), /catalog_html_empty_or_too_large/);
  assert.equal(streamedBodyCancelled, true, "cancel oversized streamed response instead of buffering it fully");
  const arabicHtml = "<span>منظفات وعناية</span>";
  const arabicBytes = new TextEncoder().encode(arabicHtml);
  const splitAt = arabicBytes.findIndex((byte, index) => index > 6 && (byte & 0xc0) === 0x80);
  assert.ok(splitAt > 0, "fixture should include a split inside a multibyte UTF-8 character");
  const utf8Chunks = [arabicBytes.slice(0, splitAt), arabicBytes.slice(splitAt)];
  let chunkIndex = 0;
  const decodedArabicHtml = await fetchStorePage("https://snapflyer.io/eg/downtown/stores/kazyon", {
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: name => name === "content-type" ? "text/html; charset=utf-8" : null },
      body: { getReader: () => ({
        read: async () => chunkIndex < utf8Chunks.length
          ? { done: false, value: utf8Chunks[chunkIndex++] }
          : { done: true },
        cancel: async () => {},
        releaseLock: () => {}
      }) }
    })
  });
  assert.equal(decodedArabicHtml, arabicHtml, "stream decoding must preserve Arabic across UTF-8 chunk boundaries");
  let bodyTimeoutObserved = false;
  await assert.rejects(() => fetchStorePage("https://snapflyer.io/eg/downtown/stores/kazyon", {
    timeoutMs: 5,
    fetchImpl: async (_url, options) => ({
      ok: true, status: 200,
      headers: { get: name => name === "content-type" ? "text/html" : null },
      body: { getReader: () => ({
        read: () => new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            bodyTimeoutObserved = true;
            reject(Object.assign(new Error("body aborted"), { name: "AbortError" }));
          }, { once: true });
        }),
        cancel: async () => {},
        releaseLock: () => {}
      }) }
    })
  }), /body aborted/);
  assert.equal(bodyTimeoutObserved, true, "fetch timeout must remain active while reading a slow response body");
  const skipped = await checkCatalogsOnce({ pool: null, telegram: null, chatId: null });
  assert.equal(skipped.skipped, true);
  console.log("catalog newsletter scheduler tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });


function makePipelinePool() {
  const rows = new Map();
  let nextId = 1;
  return {
    rows,
    async query(sql, params = []) {
      if (sql.startsWith("SELECT fingerprint")) {
        const matches = [...rows.values()].filter(r => r.store_key === params[0] && r.catalog_url === params[1])
          .sort((a, b) => b.id - a.id);
        return { rows: matches.length ? [{ fingerprint: matches[0].fingerprint }] : [] };
      }
      if (sql.startsWith("SELECT id FROM catalog_newsletter_snapshots WHERE store_key")) {
        return { rows: [...rows.values()].some(r => r.store_key === params[0]) ? [{ id: 1 }] : [] };
      }
      if (sql.startsWith("INSERT INTO catalog_newsletter_deliveries")) {
        const [snapshot_id, chat_id] = params;
        const existing = [...rows.values()].find(r => r.snapshot_id === snapshot_id && r.chat_id === chat_id && r.delivery === true);
        if (existing) return { rowCount: 0, rows: [] };
        const row = { id: nextId++, snapshot_id, chat_id, status: "prepared", delivery: true };
        rows.set("delivery-" + row.id, row);
        return { rowCount: 1, rows: [{ id: row.id }] };
      }
      if (sql.startsWith("INSERT") && sql.includes("RETURNING id")) {
        const [store_key, catalog_url, fingerprint, title, region, displayed_date_range] = params;
        const exists = [...rows.values()].some(r => r.store_key === store_key && r.catalog_url === catalog_url && r.fingerprint === fingerprint);
        if (exists) return { rowCount: 0, rows: [] };
        const row = { id: nextId++, store_key, catalog_url, fingerprint, title, region, displayed_date_range, status: "pending" };
        rows.set(row.id, row);
        return { rowCount: 1, rows: [{ id: row.id }] };
      }
      if (sql.startsWith("INSERT")) {
        const [store_key, catalog_url, fingerprint, title, region, displayed_date_range, status] = params;
        const exists = [...rows.values()].some(r => r.store_key === store_key && r.catalog_url === catalog_url && r.fingerprint === fingerprint);
        if (!exists) rows.set(nextId, { id: nextId++, store_key, catalog_url, fingerprint, title, region, displayed_date_range, status });
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE") && sql.includes("last_seen_at")) return { rowCount: 1, rows: [] };
      if (sql.startsWith("SELECT id,store_key")) {
        return { rows: [...rows.values()].filter(r => r.status === "pending").slice(0, params[0]) };
      }
      if (sql.startsWith("UPDATE catalog_newsletter_deliveries")) {
        const row = [...rows.values()].find(r => r.id === params[0] && r.delivery === true);
        if (row && row.status === "prepared") { row.status = params[1]; row.message_id = params[2]; }
        return { rowCount: row ? 1 : 0, rows: [] };
      }
      if (sql.startsWith("SELECT chat_id,status FROM catalog_newsletter_deliveries")) {
        return { rows: [...rows.values()].filter(r => r.delivery === true && r.snapshot_id === params[0]).map(r => ({ chat_id: r.chat_id, status: r.status })) };
      }
      if (sql.startsWith("UPDATE") && sql.includes("RETURNING id")) {
        const row = rows.get(params[0]);
        if (!row || row.status !== "pending") return { rowCount: 0, rows: [] };
        row.status = params[1];
        return { rowCount: 1, rows: [{ id: row.id }] };
      }
      throw new Error("Unexpected SQL in pipeline test: " + sql);
    }
  };
}

(async () => {
  const { CATALOG_STORES } = require("../modules/catalog-newsletter");
  const pool = makePipelinePool();
  const fetchPage = async url => {
    const storeKey = Object.entries(CATALOG_STORES).find(([, store]) => store.url === url)?.[0];
    assert.ok(storeKey, "scheduler requested a configured store URL");
    const slug = CATALOG_STORES[storeKey].catalogSlug;
    return `<a href="/eg/downtown/offers/${slug}/1376"><span>${storeKey} flyer October 2026</span></a>`;
  };
  const sent = [];
  const telegram = { sendMessage: async (chatId, message) => { sent.push({ chatId, message }); } };

  // First observation is a quiet baseline, so it must not publish.
  const first = await checkCatalogsOnce({ pool, telegram, chatId: -100123, fetchPage });
  assert.equal(first.checkedStores, Object.keys(CATALOG_STORES).length);
  assert.equal(first.published, 0);
  assert.equal(sent.length, 0);

  // A newly listed flyer for a store with history becomes pending and publishes once.
  const fetchTwoNewCatalogs = async url => {
    const storeKey = Object.entries(CATALOG_STORES).find(([, store]) => store.url === url)?.[0];
    assert.ok(storeKey, "scheduler requested a configured store URL");
    const slug = CATALOG_STORES[storeKey].catalogSlug;
    return `<a href="/eg/downtown/offers/${slug}/1377"><span>${storeKey} flyer November 2026</span></a>` +
      `<a href="/eg/downtown/offers/${slug}/1378"><span>${storeKey} flyer December 2026</span></a>`;
  };
  const second = await checkCatalogsOnce({ pool, telegram, chatIds: [-100123, -100456], fetchPage: fetchTwoNewCatalogs });
  assert.equal(second.published, Object.keys(CATALOG_STORES).length * 1 * 2, "only one catalog per store should be delivered to both approved groups");
  assert.equal(sent.length, Object.keys(CATALOG_STORES).length * 1 * 2);
  assert.ok(sent.some(item => item.chatId === -100123));
  assert.ok(sent.some(item => item.chatId === -100456));
  assert.ok(sent.some(item => item.message.includes("November 2026")));
  assert.ok(!sent.some(item => item.message.includes("December 2026")), "the second edition for a store must not publish in the same poll");

  // Next poll sees the same two catalogs per store and must not publish duplicates.
  const third = await checkCatalogsOnce({ pool, telegram, chatId: -100123, fetchPage: fetchTwoNewCatalogs });
  assert.equal(third.published, 0);
  assert.equal(sent.length, Object.keys(CATALOG_STORES).length * 1 * 2);

  // If every source fails, no stale pending notice is published by this run.
  const allFail = await checkCatalogsOnce({
    pool, telegram, chatId: -100123,
    fetchPage: async () => { throw new Error("source offline"); }
  });
  assert.equal(allFail.skipped, true);
  assert.equal(allFail.reason, "all_sources_failed");

  // A Telegram failure moves the snapshot out of the pending queue; the terminal delivery record prevents ambiguous automatic retries.
  const retryPool = makePipelinePool();
  await checkCatalogsOnce({ pool: retryPool, telegram, chatId: -100123, fetchPage });
  await retryPool.query(
    "INSERT INTO catalog_newsletter_snapshots(store_key,catalog_url,fingerprint,title,region,displayed_date_range,status) VALUES($1,$2,$3,$4,$5,$6,$7)",
    ["kazyon", "https://snapflyer.io/eg/downtown/offers/kazyon/1378", "fp-new", "Kazyon flyer December 2026", "محافظة القاهرة", null, "pending"]
  );
  let publishErrors = 0;
  let ambiguousDeliveryAlert = false;
  const failingTelegram = { sendMessage: async () => { throw new Error("telegram unavailable"); } };
  const failedPublish = await checkCatalogsOnce({
    pool: retryPool, telegram: failingTelegram, chatId: -100123, fetchPage,
    onError: async (_error, meta) => {
      if (meta.stage === "catalog_publish") {
        publishErrors++;
        ambiguousDeliveryAlert = meta.deliveryOutcome === "ambiguous" && meta.manualReviewRequired === true;
      }
    }
  });
  assert.ok(failedPublish.failed >= 1);
  assert.ok(publishErrors >= 1);
  assert.equal(ambiguousDeliveryAlert, true, "Telegram send errors must explicitly flag ambiguous delivery for manual review");
  assert.ok([...retryPool.rows.values()].some(r => r.fingerprint === "fp-new" && r.status === "failed"),
    "terminal delivery failures must leave the pending queue so newer snapshots are not starved");

  const retrySent = [];
  const retry = await checkCatalogsOnce({
    pool: retryPool, telegram: { sendMessage: async (_id, message) => retrySent.push(message) },
    chatId: -100123, fetchPage
  });
  assert.equal(retrySent.length, 0, "an ambiguous Telegram send outcome must not be retried automatically");
  assert.ok([...retryPool.rows.values()].some(r => r.fingerprint === "fp-new" && r.status === "failed"),
    "the snapshot is terminally failed and its delivery record prevents automatic retry");
  // Partial delivery: one approved group succeeds while another has an ambiguous Telegram error.
  // The successful group's record must remain published, and neither group is retried automatically.
  const partialPool = makePipelinePool();
  await checkCatalogsOnce({ pool: partialPool, telegram, chatId: -100123, fetchPage });
  await partialPool.query(
    "INSERT INTO catalog_newsletter_snapshots(store_key,catalog_url,fingerprint,title,region,displayed_date_range,status) VALUES($1,$2,$3,$4,$5,$6,$7)",
    ["kazyon", "https://snapflyer.io/eg/downtown/offers/kazyon/1390", "fp-partial", "Kazyon flyer January 2027", "محافظة القاهرة", null, "pending"]
  );
  const partialSent = [];
  const partialResult = await checkCatalogsOnce({
    pool: partialPool,
    chatIds: [-100123, -100456],
    fetchPage,
    telegram: {
      sendMessage: async (chatId, message) => {
        if (chatId === -100456) throw new Error("Telegram response lost");
        partialSent.push({ chatId, message });
        return { message_id: 991 };
      }
    }
  });
  assert.equal(partialResult.published, 1, "successful group delivery should be counted");
  assert.ok(partialResult.failed >= 1, "ambiguous group delivery should be counted as failed");
  const partialDeliveries = [...partialPool.rows.values()].filter(row => row.delivery && row.snapshot_id ===
    [...partialPool.rows.values()].find(snapshot => snapshot.fingerprint === "fp-partial")?.id);
  assert.equal(partialDeliveries.find(row => row.chat_id === -100123)?.status, "published");
  assert.equal(partialDeliveries.find(row => row.chat_id === -100456)?.status, "failed");
  assert.equal(partialSent.length, 1);
  const partialRetrySent = [];
  await checkCatalogsOnce({
    pool: partialPool,
    chatIds: [-100123, -100456],
    fetchPage,
    telegram: { sendMessage: async (chatId, message) => partialRetrySent.push({ chatId, message }) }
  });
  assert.equal(partialRetrySent.length, 0, "neither successful nor ambiguous group deliveries should be resent automatically");
  assert.equal(partialSent.length, 1, "the group that already received the notice must not get a duplicate");


  // Expired pending snapshots are retained in the database but never sent.
  const expiredPool = makePipelinePool();
  await expiredPool.query(
    "INSERT INTO catalog_newsletter_snapshots(store_key,catalog_url,fingerprint,title,region,displayed_date_range,status) VALUES($1,$2,$3,$4,$5,$6,$7)",
    ["metro_market", "https://snapflyer.io/eg/downtown/offers/metro-market/1325", "fp-expired", "Metro October 2026", "محافظة القاهرة", "16 - 31 Oct", "pending"]
  );
  const expiredSent = [];
  const expiredResult = await checkCatalogsOnce({
    pool: expiredPool, telegram: { sendMessage: async (_id, message) => expiredSent.push(message) },
    chatId: -100123, fetchPage,
    now: new Date("2026-11-01T00:30:00.000Z")
  });
  assert.equal(expiredSent.some(message => message.includes("Metro October 2026")), false,
    "an expired pending catalog must not be published");
  assert.equal([...expiredPool.rows.values()].find(row => row.fingerprint === "fp-expired")?.status, "ignored",
    "expired snapshots remain stored but leave the pending queue");

  console.log("catalog newsletter end-to-end mocked pipeline tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
