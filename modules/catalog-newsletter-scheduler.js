"use strict";

const {
  CATALOG_STORES, extractCatalogs, selectOneCatalogPerStore, isCatalogExpired, parseCatalogDateRange,
  persistCatalogSnapshots, listPendingCatalogSnapshots, markCatalogSnapshot, formatCatalogNotice
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

function cairoLocalInstant(year, month, day, hour, minute) {
  // Convert a Cairo wall-clock time to an instant without assuming the UTC
  // offset is constant across the date (Egypt observes daylight-saving time).
  const desiredWallTime = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let instant = desiredWallTime;
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = cairoClock(new Date(instant));
    const actualWallTime = Date.UTC(
      actual.year, actual.month - 1, actual.day,
      actual.hour, actual.minute, actual.second, 0
    );
    const adjustment = desiredWallTime - actualWallTime;
    if (adjustment === 0) break;
    instant += adjustment;
  }
  return instant;
}

function msUntilNextCheck(now = new Date()) {
  const p = cairoClock(now);
  const elapsedToday = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + now.getMilliseconds();
  const target = (DAILY_HOUR * 60 + DAILY_MINUTE) * 60 * 1000;
  const dayOffset = elapsedToday < target ? 0 : 1;
  const nextDate = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset));
  const targetInstant = cairoLocalInstant(
    nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate(),
    DAILY_HOUR, DAILY_MINUTE
  );
  return Math.max(0, targetInstant - now.getTime());
}

async function fetchStorePage(url, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const safe = new URL(url);
  if (safe.protocol !== "https:" || safe.hostname !== "snapflyer.io" || safe.username || safe.password || (safe.port && safe.port !== "443")) {
    throw new Error("catalog_source_not_allowed");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(safe.href, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { "user-agent": "BorsaGPTCatalogChecker/1.0", accept: "text/html" }
    });
    if (!response.ok) throw new Error("catalog_http_" + response.status);
    const type = response.headers?.get?.("content-type") || "";
    if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) throw new Error("catalog_unexpected_content_type");
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (declaredLength > MAX_HTML_BYTES) throw new Error("catalog_html_empty_or_too_large");
    let html;
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value?.byteLength || 0;
          if (totalBytes > MAX_HTML_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error("catalog_html_empty_or_too_large");
          }
          if (value) chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
        html = chunks.join("");
      } finally {
        reader.releaseLock?.();
      }
    } else {
      // Lightweight test doubles and non-streaming fetch adapters may only expose text().
      html = await response.text();
      if (Buffer.byteLength(html || "", "utf8") > MAX_HTML_BYTES) throw new Error("catalog_html_empty_or_too_large");
    }
    if (!html || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) throw new Error("catalog_html_empty_or_too_large");
    return html;
  } finally { clearTimeout(timer); }
}

async function resolveChatIds({ pool, chatId, chatIds }) {
  if (Array.isArray(chatIds)) return [...new Set(chatIds.map(Number).filter(Number.isSafeInteger))];
  // Explicit chatId remains available for deterministic tests and manual runs.
  if (chatId !== undefined && chatId !== null && Number.isSafeInteger(Number(chatId))) return [Number(chatId)];
  const active = await pool.query("SELECT chat_id FROM authorized_chats WHERE active=TRUE AND chat_type IN ('group','supergroup') ORDER BY chat_id");
  return [...new Set((active.rows || []).map(row => Number(row.chat_id)).filter(Number.isSafeInteger))];
}

async function reserveDelivery(pool, snapshotId, chatId) {
  const r = await pool.query(
    "INSERT INTO catalog_newsletter_deliveries(snapshot_id,chat_id,status) VALUES($1,$2,'prepared') ON CONFLICT(snapshot_id,chat_id) DO NOTHING RETURNING id",
    [snapshotId, chatId]
  );
  return r.rows?.[0]?.id ?? null;
}

async function finishDelivery(pool, deliveryId, status, messageId = null, error = null) {
  await pool.query(
    "UPDATE catalog_newsletter_deliveries SET status=$2,message_id=$3,published_at=CASE WHEN $2='published' THEN NOW() ELSE published_at END,last_error=$4 WHERE id=$1 AND status='prepared'",
    [deliveryId, status, messageId, error ? String(error.message || error).slice(0, 500) : null]
  );
}

async function checkCatalogsOnce({ pool, telegram, chatId, chatIds, fetchPage = fetchStorePage, onError = async () => {}, now = new Date() }) {
  if (!pool || !telegram) return { skipped: true, reason: "database_or_telegram_missing" };
  const targets = await resolveChatIds({ pool, chatId, chatIds });
  if (!targets.length) return { skipped: true, reason: "no_active_authorized_groups" };
  const result = { targetGroups: targets.length, checkedStores: 0, baseline: 0, changed: 0, unchanged: 0, published: 0, failed: 0, skippedDeliveries: 0 };
  for (const [storeKey, store] of Object.entries(CATALOG_STORES)) {
    try {
      const html = await fetchPage(store.url);
      const extracted = extractCatalogs(html, storeKey);
      if (!extracted.length) throw new Error("catalog_listing_parse_empty");
      const catalogs = selectOneCatalogPerStore(extracted, now);
      result.checkedStores++;
      if (!catalogs.length) continue;
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

  const pending = await listPendingCatalogSnapshots(pool, 100);
  const eligiblePending = [];
  for (const snapshot of pending) {
    if (isCatalogExpired({ displayed_date_range: snapshot.displayed_date_range }, now)) {
      await markCatalogSnapshot(pool, snapshot.id, "ignored", "Catalog validity period has ended in Africa/Cairo");
      continue;
    }
    eligiblePending.push(snapshot);
  }
  const selectedPending = selectOneCatalogPerStore(eligiblePending.map(snapshot => ({
    ...snapshot, store: snapshot.store_key
  })), now);
  const selectedIds = new Set(selectedPending.map(snapshot => snapshot.id));
  for (const snapshot of eligiblePending) {
    if (!selectedIds.has(snapshot.id)) {
      await markCatalogSnapshot(pool, snapshot.id, "ignored", "Superseded by a newer valid catalog for the same store");
    }
  }
  for (const snapshot of selectedPending) {
    for (const targetChatId of targets) {
      let deliveryId;
      try {
        deliveryId = await reserveDelivery(pool, snapshot.id, targetChatId);
        if (!deliveryId) { result.skippedDeliveries++; continue; }
      } catch (error) {
        result.failed++;
        await onError(error, { stage: "catalog_delivery_reserve", store: snapshot.store_key, snapshotId: snapshot.id, chatId: targetChatId });
        continue;
      }
      try {
        const message = await telegram.sendMessage(targetChatId, formatCatalogNotice(snapshot), { disable_web_page_preview: false });
        await finishDelivery(pool, deliveryId, "published", message?.message_id ?? null);
        result.published++;
      } catch (error) {
        // A send error may mean Telegram accepted the message but its response was lost.
        // Mark the reservation terminal so a later poll cannot create a duplicate.
        await finishDelivery(pool, deliveryId, "failed", null, error).catch(() => {});
        result.failed++;
        await onError(error, { stage: "catalog_publish", store: snapshot.store_key, snapshotId: snapshot.id, chatId: targetChatId, deliveryOutcome: "ambiguous", manualReviewRequired: true });
      }
    }
    // Preserve legacy snapshot status as a summary only. Per-group delivery records
    // are authoritative, and no snapshot is marked published while any target failed.
    try {
      const statuses = await pool.query("SELECT chat_id,status FROM catalog_newsletter_deliveries WHERE snapshot_id=$1", [snapshot.id]);
      const statusByChat = new Map(statuses.rows.map(row => [Number(row.chat_id), row.status]));
      const allPublished = targets.every(target => statusByChat.get(target) === "published");
      const terminalStatuses = ["published", "failed", "prepared"];
      const allTerminal = targets.every(target => terminalStatuses.includes(statusByChat.get(target)));
      if (allPublished) {
        await markCatalogSnapshot(pool, snapshot.id, "published");
      } else if (allTerminal) {
        // "prepared" is also terminal here: the process may have stopped after
        // reserving delivery but before receiving Telegram's response. Never
        // retry an ambiguous send automatically, and do not let it starve newer
        // snapshots in the pending queue.
        const unresolvedTargets = targets.filter(target => statusByChat.get(target) !== "published");
        await markCatalogSnapshot(
          pool,
          snapshot.id,
          "failed",
          `Terminal or ambiguous delivery for chat IDs: ${unresolvedTargets.join(",")}`
        );
      }
    } catch (error) {
      await onError(error, { stage: "catalog_snapshot_summary", store: snapshot.store_key, snapshotId: snapshot.id });
    }
  }
  return result;
}

function startCatalogNewsletterScheduler(options) {
  let stopped = false, timer = null, running = false;
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

module.exports = { CAIRO_ZONE, DAILY_HOUR, DAILY_MINUTE, FETCH_TIMEOUT_MS, cairoClock, msUntilNextCheck, fetchStorePage, resolveChatIds, reserveDelivery, finishDelivery, checkCatalogsOnce, startCatalogNewsletterScheduler };
