"use strict";

const {
  CATALOG_STORES, extractCatalogs, persistCatalogSnapshots,
  listPendingCatalogSnapshots, markCatalogSnapshot, formatCatalogNotice
} = require("./catalog-newsletter");

const CAIRO_ZONE = "Africa/Cairo";
const DAILY_HOUR = 10;
const DAILY_MINUTE = 10;
const FETCH_TIMEOUT_MS = 12000;
const MAX_HTML_BYTES = 2_000_000;

function cairoClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CAIRO_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
}

function msUntilNextCheck(now = new Date()) {
  const p = cairoClock(now);
  const elapsedToday = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + now.getMilliseconds();
  const target = (DAILY_HOUR * 60 + DAILY_MINUTE) * 60 * 1000;
  return elapsedToday < target ? target - elapsedToday : 24 * 60 * 60 * 1000 - elapsedToday + target;
}

async function fetchStorePage(url, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const safe = new URL(url);
  if (safe.protocol !== "https:" || safe.hostname !== "snapflyer.io" || safe.username || safe.password) {
    throw new Error("catalog_source_not_allowed");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(safe.href, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { "user-agent": "BorsaGPTCatalogChecker/1.0", accept: "text/html" }
    });
    if (!response.ok) throw new Error("catalog_http_" + response.status);
    const type = response.headers?.get?.("content-type") || "";
    if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) throw new Error("catalog_unexpected_content_type");
    const html = await response.text();
    if (!html || html.length > MAX_HTML_BYTES) throw new Error("catalog_html_empty_or_too_large");
    return html;
  } finally {
    clearTimeout(timer);
  }
}

async function checkCatalogsOnce({ pool, telegram, chatId, fetchPage = fetchStorePage, onError = async () => {} }) {
  if (!pool || !telegram || !chatId) return { skipped: true, reason: "database_telegram_or_chat_missing" };
  const result = { checkedStores: 0, baseline: 0, changed: 0, unchanged: 0, published: 0, failed: 0 };
  for (const [storeKey, store] of Object.entries(CATALOG_STORES)) {
    try {
      const html = await fetchPage(store.url);
      const catalogs = extractCatalogs(html, storeKey);
      if (!catalogs.length) throw new Error("catalog_listing_parse_empty");
      result.checkedStores++;
      const saved = await persistCatalogSnapshots(pool, catalogs);
      result.baseline += saved.baseline;
      result.changed += saved.changed;
      result.unchanged += saved.unchanged;
    } catch (error) {
      result.failed++;
      await onError(error, { stage: "catalog_fetch", store: storeKey });
    }
  }
  if (result.failed === Object.keys(CATALOG_STORES).length) return { ...result, skipped: true, reason: "all_sources_failed" };
  const pending = await listPendingCatalogSnapshots(pool, 20);
  for (const snapshot of pending) {
    try {
      await telegram.sendMessage(chatId, formatCatalogNotice(snapshot), { disable_web_page_preview: false });
      const marked = await markCatalogSnapshot(pool, snapshot.id, "published");
      if (marked) result.published++;
    } catch (error) {
      result.failed++;
      await onError(error, { stage: "catalog_publish", store: snapshot.store_key, snapshotId: snapshot.id });
    }
  }
  return result;
}

function startCatalogNewsletterScheduler(options) {
  let stopped = false;
  let timer = null;
  let running = false;
  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      if (!running) {
        running = true;
        try { await checkCatalogsOnce(options); }
        catch (error) { await options.onError?.(error, { stage: "catalog_scheduler_tick" }); }
        finally { running = false; }
      }
      scheduleNext();
    }, msUntilNextCheck());
    timer.unref?.();
  };
  scheduleNext();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

module.exports = { CAIRO_ZONE, DAILY_HOUR, DAILY_MINUTE, FETCH_TIMEOUT_MS, cairoClock, msUntilNextCheck, fetchStorePage, checkCatalogsOnce, startCatalogNewsletterScheduler };
