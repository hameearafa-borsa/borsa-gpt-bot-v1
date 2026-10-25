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
assert.equal(msUntilNextCheck(after), 23 * 60 * 60 * 1000 - 60 * 1000);

(async () => {
  await assert.rejects(() => fetchStorePage("https://evil.example/"), /catalog_source_not_allowed/);
  const html = await fetchStorePage("https://snapflyer.io/eg/downtown/stores/kazyon", {
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => "<html>ok</html>" })
  });
  assert.equal(html, "<html>ok</html>");
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
  const html = '<a href="/eg/downtown/offers/kazyon/1376"><span>Kazyon flyer October 2026</span></a>';
  const fetchPage = async () => html;
  const sent = [];
  const telegram = { sendMessage: async (chatId, message) => { sent.push({ chatId, message }); } };

  // First observation is a quiet baseline, so it must not publish.
  const first = await checkCatalogsOnce({ pool, telegram, chatId: -100123, fetchPage });
  assert.equal(first.checkedStores, Object.keys(CATALOG_STORES).length);
  assert.equal(first.published, 0);
  assert.equal(sent.length, 0);

  // A newly listed flyer for a store with history becomes pending and publishes once.
  const changedHtml = '<a href="/eg/downtown/offers/kazyon/1377"><span>Kazyon flyer November 2026</span></a>';
  const second = await checkCatalogsOnce({ pool, telegram, chatId: -100123, fetchPage: async () => changedHtml });
  assert.equal(second.published, Object.keys(CATALOG_STORES).length);
  assert.equal(sent.length, Object.keys(CATALOG_STORES).length);
  assert.ok(sent.every(item => item.message.includes("November 2026")));

  // Next poll sees the same catalog and must not publish a duplicate.
  const third = await checkCatalogsOnce({ pool, telegram, chatId: -100123, fetchPage: async () => changedHtml });
  assert.equal(third.published, 0);
  assert.equal(sent.length, Object.keys(CATALOG_STORES).length);

  // If every source fails, no stale pending notice is published by this run.
  const allFail = await checkCatalogsOnce({
    pool, telegram, chatId: -100123,
    fetchPage: async () => { throw new Error("source offline"); }
  });
  assert.equal(allFail.skipped, true);
  assert.equal(allFail.reason, "all_sources_failed");

  // A Telegram failure leaves the pending row untouched; a later run retries it.
  const retryPool = makePipelinePool();
  await checkCatalogsOnce({ pool: retryPool, telegram, chatId: -100123, fetchPage });
  await retryPool.query(
    "INSERT INTO catalog_newsletter_snapshots(store_key,catalog_url,fingerprint,title,region,displayed_date_range,status) VALUES($1,$2,$3,$4,$5,$6,$7)",
    ["kazyon", "https://snapflyer.io/eg/downtown/offers/kazyon/1378", "fp-new", "Kazyon flyer December 2026", "محافظة القاهرة", null, "pending"]
  );
  let publishErrors = 0;
  const failingTelegram = { sendMessage: async () => { throw new Error("telegram unavailable"); } };
  const failedPublish = await checkCatalogsOnce({
    pool: retryPool, telegram: failingTelegram, chatId: -100123, fetchPage,
    onError: async (_error, meta) => { if (meta.stage === "catalog_publish") publishErrors++; }
  });
  assert.ok(failedPublish.failed >= 1);
  assert.ok(publishErrors >= 1);
  assert.ok([...retryPool.rows.values()].some(r => r.fingerprint === "fp-new" && r.status === "pending"));

  const retrySent = [];
  const retry = await checkCatalogsOnce({
    pool: retryPool, telegram: { sendMessage: async (_id, message) => retrySent.push(message) },
    chatId: -100123, fetchPage
  });
  assert.ok(retrySent.some(message => message.includes("December 2026")));
  assert.ok(![...retryPool.rows.values()].some(r => r.fingerprint === "fp-new" && r.status === "pending"));
  console.log("catalog newsletter end-to-end mocked pipeline tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
