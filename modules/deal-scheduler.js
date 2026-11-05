"use strict";
const { collectDealCandidates } = require("./deal-sources");
const { filterRecentDeals, distributeDeals, formatNewsletterMessage } = require("./deal-publication");
const { dealFingerprint, dealProductFingerprint, validateDeal } = require("./deals");
const { isServiceEnabled } = require("../core/service-settings");

function cairoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type,p.value]));
}
function batchKey(date = new Date()) { const p = cairoParts(date); return `${p.year}-${p.month}-${p.day}`; }
function newsletterKindAt(date = new Date()) {
  const p = cairoParts(date);
  const hour = Number(p.hour), minute = Number(p.minute);
  // Amazon collection uses three paid searches. Keep its edition eligible
  // from 5:00 through 5:44 PM for restart recovery.
  // Other stores need seven ScraperAPI searches plus up to six sequential
  // SnapFlyer page fetches. Start at 6:30 PM, leaving 45 minutes after the
  // Amazon retry window, and keep a 60-minute recovery window. This ends
  // 30 minutes before the 8 PM price digest.
  if (hour === 17 && minute < 45) return "amazon";
  if (hour === 18 && minute >= 30) return "other_sites";
  if (hour === 19 && minute < 30) return "other_sites";
  return null;
}
function isNewsletterWindow(date = new Date()) { return newsletterKindAt(date) !== null; }
function selectNewsletterDeals(recent, kind) {
  const isAmazon = d => {
    try {
      const host = new URL(d.url).hostname.toLowerCase();
      return host === "www.amazon.eg" || host === "amazon.eg";
    } catch { return false; }
  };
  // Balance each edition independently so Amazon cannot crowd out the 6 PM edition.
  const editionPool = recent.filter(d => kind === "amazon" ? isAmazon(d) : !isAmazon(d));
  const balanced = distributeDeals(editionPool);
  return [...balanced.detergent, ...balanced.paper, ...balanced.personal_care];
}

async function verifyProductUrl(raw, { fetchImpl = globalThis.fetch, timeoutMs = 7000, maxRedirects = 5 } = {}) {
  const allowedHosts = new Set(["www.amazon.eg", "amazon.eg", "www.jumia.com.eg", "jumia.com.eg", "www.noon.com", "noon.com", "www.carrefouregypt.com", "carrefouregypt.com", "snapflyer.io"]);
  const isAllowedSnapFlyerUrl = url =>
    url.hostname.toLowerCase() === "snapflyer.io" && (
      /^\/eg\/downtown\/offers\/(?:kazyon|bim|metro-market)\/\d+\/?$/i.test(url.pathname) ||
      /^\/product\/\d+\/?$/i.test(url.pathname) ||
      /^\/eg\/[a-z0-9-]+\/products\/\d+\/?$/i.test(url.pathname)
    );
  const safeUrl = value => {
    try {
      const u = new URL(value);
      if (u.protocol !== "https:" || !allowedHosts.has(u.hostname.toLowerCase()) || u.username || u.password || (u.port && u.port !== "443")) return null;
      if (u.hostname.toLowerCase() === "snapflyer.io" && !isAllowedSnapFlyerUrl(u)) return null;
      return u;
    } catch { return null; }
  };
  let url = safeUrl(raw);
  if (!url) return { ok: false, reason: "host_not_allowed" };
  const originalSnapFlyerUrl = url.hostname.toLowerCase() === "snapflyer.io" ? url : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let method = "HEAD";
    let headers;
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const response = await fetchImpl(url, { method, ...(headers ? { headers } : {}), redirect: "manual", signal: controller.signal });
      if (method === "HEAD" && [403, 405, 501].includes(response.status)) {
        method = "GET";
        headers = { Range: "bytes=0-0" };
        redirects--;
        continue;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.("location") || response.headers?.location;
        if (!location) return { ok: false, reason: "redirect_without_location" };
        if (redirects === maxRedirects) return { ok: false, reason: "too_many_redirects" };
        let resolvedLocation;
        try { resolvedLocation = new URL(location, url).href; }
        catch { return { ok: false, reason: "redirect_host_not_allowed" }; }
        const next = safeUrl(resolvedLocation);
        if (!next) return { ok: false, reason: "redirect_host_not_allowed" };
        // SnapFlyer product and catalog links must retain their exact target.
        // Never let a redirect silently replace a product with another item or store.
        if (originalSnapFlyerUrl) {
          const productId = value =>
            value.pathname.match(/^\/product\/(\d+)\/?$/i)?.[1] ||
            value.pathname.match(/^\/eg\/[a-z0-9-]+\/products\/(\d+)\/?$/i)?.[1] || null;
          const originalProductId = productId(originalSnapFlyerUrl);
          const nextProductId = productId(next);
          const sameProduct = originalProductId && nextProductId === originalProductId;
          const sameCatalog = !originalProductId &&
            next.pathname.replace(/\/$/, "").toLowerCase() === originalSnapFlyerUrl.pathname.replace(/\/$/, "").toLowerCase();
          if (next.hostname.toLowerCase() !== originalSnapFlyerUrl.hostname.toLowerCase() || (!sameProduct && !sameCatalog)) {
            return { ok: false, reason: "snapflyer_catalog_redirect_changed" };
          }
        }
        url = next;
        continue;
      }
      // Only successful 2xx responses verify a product page. Unhandled 3xx
      // statuses (for example 304) are not proof that the URL is reachable.
      const ok = response.status >= 200 && response.status < 300;
      return { ok, status: response.status, finalUrl: url.href, reason: ok ? null : "http_error" };
    }
    return { ok: false, reason: "too_many_redirects" };
  } catch (error) {
    return { ok: false, reason: error.name === "AbortError" ? "timeout" : "fetch_failed" };
  } finally { clearTimeout(timer); }
}
async function verifyDeals(deals, options = {}) {
  const output = [];
  for (let i = 0; i < deals.length; i += 5) {
    const group = deals.slice(i, i + 5);
    const results = await Promise.all(group.map(d => verifyProductUrl(d.url, options)));
    results.forEach((r,j) => {
      if (r.ok) {
        output.push({ ...group[j], url: r.finalUrl, verified_url: true });
        return;
      }
      // Retailers and scraping proxies may block HEAD/GET checks even when a
      // product page exists. Keep allowlisted candidates when reachability is
      // inconclusive; drop only links explicitly rejected by URL/redirect safety.
      const transientHttp = r.reason === "http_error" &&
        (r.status === 403 || r.status === 429 || r.status >= 500);
      const inconclusive = transientHttp || r.reason === "timeout" || r.reason === "fetch_failed";
      if (inconclusive) output.push({ ...group[j], verified_url: false, verification_note: r.reason });
    });
  }
  return output;
}
async function persistDeals(pool, deals) {
  let saved = 0;
  for (const d of deals) {
    const valid = validateDeal(d); if (!valid.ok) continue;
    await pool.query(`INSERT INTO deal_observations(merchant,title,url,category,price,old_price,discount_pct,fingerprint,product_fingerprint,observed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT(fingerprint) DO UPDATE SET observed_at=NOW(), price=EXCLUDED.price, old_price=EXCLUDED.old_price, discount_pct=EXCLUDED.discount_pct, product_fingerprint=EXCLUDED.product_fingerprint`,
      [d.merchant,d.title,d.url,d.category,d.price,d.old_price || null,d.discount_pct || 0,dealFingerprint(d),dealProductFingerprint(d)]);
    saved++;
  }
  return saved;
}
async function enqueueObservedDeals(pool, deals, source = "unknown") {
  const saved = await persistDeals(pool, deals);
  let queued = 0;
  for (const deal of deals) {
    const valid = validateDeal(deal);
    if (!valid.ok) continue;
    const result = await pool.query(
      `INSERT INTO deal_publication_queue(fingerprint,source,status,first_queued_at,last_observed_at,updated_at)
       VALUES($1,$2,'queued',NOW(),NOW(),NOW())
       ON CONFLICT(fingerprint) DO UPDATE
       SET source=EXCLUDED.source,last_observed_at=NOW(),updated_at=NOW(),
           status=CASE WHEN deal_publication_queue.status='published' THEN 'published' ELSE 'queued' END
       RETURNING fingerprint,status`,
      [valid.fingerprint, source]
    );
    if (result.rowCount) queued++;
  }
  return { saved, queued };
}
async function loadQueuedDeals(pool, source = "amazon", limit = 500) {
  await pool.query(
    `UPDATE deal_publication_queue
     SET status='expired',updated_at=NOW()
     WHERE source=$1 AND status='queued'
       AND last_observed_at < NOW() - INTERVAL '36 hours'`,
    [source]
  );
  const result = await pool.query(
    `SELECT o.merchant,o.title,o.url,o.category,o.price,o.old_price,o.discount_pct,
            o.fingerprint,o.product_fingerprint,q.first_queued_at,q.last_observed_at
     FROM deal_publication_queue q
     JOIN deal_observations o ON o.fingerprint=q.fingerprint
     WHERE q.source=$1 AND q.status='queued'
       AND q.last_observed_at >= NOW() - INTERVAL '36 hours'
     ORDER BY q.first_queued_at ASC
     LIMIT $2`,
    [source, limit]
  );
  return result.rows || [];
}
async function updateQueuedDeals(pool, deals, status) {
  const fingerprints = [...new Set((deals || []).map(deal => deal.fingerprint).filter(Boolean))];
  if (!fingerprints.length) return 0;
  const result = await pool.query(
    `UPDATE deal_publication_queue
     SET status=$2, published_at=CASE WHEN $2='published' THEN NOW() ELSE published_at END, updated_at=NOW()
     WHERE fingerprint = ANY($1::text[]) AND status='queued'`,
    [fingerprints, status]
  );
  return result.rowCount || 0;
}
async function resolveDealChatIds({ pool, chatId, chatIds }) {
  if (Array.isArray(chatIds)) return [...new Set(chatIds.map(Number).filter(Number.isSafeInteger))];
  // Explicit chatId is retained for tests and intentional single-group runs.
  if (chatId !== undefined && chatId !== null && Number.isSafeInteger(Number(chatId))) return [Number(chatId)];
  const r = await pool.query("SELECT chat_id FROM authorized_chats WHERE active=TRUE AND chat_type IN ('group','supergroup') ORDER BY chat_id");
  return [...new Set((r.rows || []).map(row => Number(row.chat_id)).filter(Number.isSafeInteger))];
}

async function publishDailyDeals({ pool, telegram, chatId, chatIds, fetcher = collectDealCandidates, verify = verifyDeals, now = new Date(), onError = async () => {}, onDiagnostics = async () => {} }) {
  if (!pool || !telegram) return { skipped: true, reason: "database_or_telegram_missing" };
  if (!(await isServiceEnabled(pool, "deals"))) return { skipped: true, reason: "service_disabled" };
  const requestedChatIds = await resolveDealChatIds({ pool, chatId, chatIds });
  const targetChatIds = [];
  for (const id of requestedChatIds) if (await isServiceEnabled(pool, "deals", id)) targetChatIds.push(id);
  if (!targetChatIds.length) return { skipped: true, reason: "no_active_authorized_groups" };
  const kind = newsletterKindAt(now);
  if (!kind) return { skipped: true, reason: "outside_newsletter_hours" };
  const key = batchKey(now);
  const existing = await pool.query(
    "SELECT channel_kind,status,chat_id FROM deal_publications WHERE batch_key=$1 AND channel_kind=$2 AND chat_id = ANY($3::bigint[])",
    [key, kind, targetChatIds]
  );
  const reservedChats = new Set(existing.rows.filter(row => row.channel_kind === kind).map(row => Number(row.chat_id)));
  const publishedChats = new Set(existing.rows.filter(row => row.channel_kind === kind && row.status === "published").map(row => Number(row.chat_id)));
  const unreservedTargets = targetChatIds.filter(id => !reservedChats.has(id));
  if (!unreservedTargets.length) {
    return {
      skipped: true,
      reason: targetChatIds.every(id => publishedChats.has(id)) ? "already_published" : "all_targets_already_reserved",
      batchKey: key, kind
    };
  }

  // Collect and verify once per edition, regardless of the number of target groups.
  const collectionStartedAt = Date.now();
  const gathered = await fetcher({ edition: kind });
  const safeSourceStats = (gathered.sourceStats || []).map(stat => {
    const extraction = stat.extractionDiagnostics || {};
    const stages = extraction.stages || {};
    const summarizeCounters = counters => counters ? Object.fromEntries(
      ["candidates","accepted","rejectedName","rejectedUrl","rejectedPrice","rejectedCurrency","rejectedValidation"].map(key => [key, Number(counters[key] || 0)])
    ) : undefined;
    return {
      source: stat.source || "unknown",
      ...(Number.isInteger(stat.queryIndex) ? { queryIndex: stat.queryIndex } : {}),
      ok: Boolean(stat.ok), stage: stat.stage || "unknown",
      extractedCount: Number(stat.extractedCount || 0),
      ...(stat.reason ? { reason: String(stat.reason).slice(0, 80) } : {}),
      ...(stat.pageSignal ? { pageSignal: stat.pageSignal } : {}),
      ...(stages.json || stages.html ? { parser: {
        json: summarizeCounters(stages.json), html: summarizeCounters(stages.html),
        structuredProductObjects: Number(extraction.structuredProductObjects || 0),
        htmlCardChunks: Number(extraction.htmlCardChunks || 0)
      } } : {})
    };
  });
  const diagnosticsBase = {
    kind, batchKey: key, sourceCount: gathered.sourceCount ?? null,
    gatheredCount: (gathered.deals || []).length,
    errors: (gathered.errors || []).map(item => ({
      source: String(item.source || "unknown"),
      reason: String(item.reason || "unknown").slice(0, 80),
      ...(item.pageSignal ? { pageSignal: item.pageSignal } : {})
    })),
    sources: safeSourceStats
  };
  const emitDiagnostics = async details => {
    try { await onDiagnostics(details); } catch { /* Diagnostics must never block publication. */ }
  };
  await emitDiagnostics({ ...diagnosticsBase, stage: "collected", elapsedMs: Date.now() - collectionStartedAt });
  if (!gathered.deals?.length && kind !== "amazon") {
    await onError(new Error("No validated deal candidates; newsletter not published"), { stage: "fetch", errors: gathered.errors || [], sourceStats: gathered.sourceStats || [], sourceSummary: gathered.sourceSummary || [], sourceCount: gathered.sourceCount ?? null, batchKind: kind, batchKey: key });
    return { skipped: true, reason: "no_deals", sourceErrors: gathered.errors || [], sourceStats: gathered.sourceStats || [], sourceSummary: gathered.sourceSummary || [], sourceCount: gathered.sourceCount ?? null };
  }
  const verified = await verify(gathered.deals || []);
  // Amazon observations enter a durable queue before newsletter selection.
  // Pending items survive daily collection runs until published or expired.
  const duplicateCooldownDays = kind === "amazon" ? 0 : 7;
  let recent;
  if (kind === "amazon") {
    await enqueueObservedDeals(pool, verified, "amazon");
    const queued = await loadQueuedDeals(pool, "amazon");
    const refreshedQueue = await verify(queued);
    const refreshedFingerprints = new Set(refreshedQueue.map(deal => deal.fingerprint));
    const rejectedQueueItems = queued.filter(deal => !refreshedFingerprints.has(deal.fingerprint));
    await updateQueuedDeals(pool, rejectedQueueItems, "expired");
    recent = refreshedQueue;
  } else {
    recent = await filterRecentDeals(pool, verified, duplicateCooldownDays);
  }
  if (!recent.length) {
    await emitDiagnostics({ ...diagnosticsBase, stage: "filtered", verifiedCount: verified.length, recentCount: 0, selectedCount: 0, duplicateCooldownDays, elapsedMs: Date.now() - collectionStartedAt });
    return { skipped: true, reason: "all_recent_or_invalid", sourceErrors: gathered.errors || [] };
  }
  const items = selectNewsletterDeals(recent, kind);
  await emitDiagnostics({
    ...diagnosticsBase, stage: "filtered", verifiedCount: verified.length,
    recentCount: recent.length, selectedCount: items.length,
    selectedByMerchant: Object.fromEntries([...new Set(items.map(item => String(item.merchant || "unknown")))].map(merchant => [merchant, items.filter(item => String(item.merchant || "unknown") === merchant).length])),
    duplicateCooldownDays, elapsedMs: Date.now() - collectionStartedAt
  });
  if (!items.length) {
    await onError(new Error("No validated deal candidates for scheduled newsletter"), { stage: "fetch", errors: gathered.errors || [], sourceStats: gathered.sourceStats || [], sourceSummary: gathered.sourceSummary || [], sourceCount: gathered.sourceCount ?? null, batchKind: kind, batchKey: key });
    return { skipped: true, reason: "no_deals", kind, sourceErrors: gathered.errors || [] };
  }
  const title = kind === "amazon"
    ? "عروض أمازون للمنظفات والورقيات والعناية"
    : "عروض المتاجر الأخرى المختارة";
  const formatted = formatNewsletterMessage(items, title);
  const formattedItems = formatted.items;
  if (!formattedItems.length) {
    await onError(new Error("No complete product blocks fit in the Telegram newsletter limit"), { stage: "format", batchKind: kind, batchKey: key });
    return { skipped: true, reason: "message_too_long", batchKey: key, kind };
  }

  const published = [];
  for (const targetId of unreservedTargets) {
    const reservation = await pool.query(
      "INSERT INTO deal_publications(batch_key,channel_kind,chat_id,item_count,status) VALUES($1,$2,$3,$4,'prepared') ON CONFLICT(batch_key,channel_kind,chat_id) DO NOTHING RETURNING id",
      [key, kind, targetId, formattedItems.length]
    );
    if (!reservation.rowCount) {
      // A prepared/failed reservation may represent an ambiguous Telegram outcome.
      // Never auto-repeat it; a human can inspect and repair the record if needed.
      continue;
    }
    let msg;
    try {
      msg = await telegram.sendMessage(targetId, formatted.text, { disable_web_page_preview: true, parse_mode: "HTML" });
    } catch (error) {
      await pool.query("UPDATE deal_publications SET status='failed' WHERE id=$1", [reservation.rows[0].id]).catch(() => {});
      await onError(error, { stage: "publish", batchKind: kind, batchKey: key, chatId: targetId });
      continue;
    }

    published.push({ kind, count: formattedItems.length, messageId: msg.message_id, chatId: targetId });
    try {
      await pool.query("UPDATE deal_publications SET status='published',published_at=NOW(),message_id=$1 WHERE id=$2", [msg.message_id, reservation.rows[0].id]);
    } catch (error) {
      await onError(error, { stage: "publication_record", batchKind: kind, batchKey: key, messageId: msg.message_id, chatId: targetId });
    }
  }

  // Amazon offers were persisted and queued before selection. Mark only the
  // formatted offers as published after Telegram confirms at least one send.
  if (published.length) {
    try {
      if (kind === "amazon") await updateQueuedDeals(pool, formattedItems, "published");
      else await persistDeals(pool, formattedItems);
    } catch (error) {
      await onError(error, { stage: kind === "amazon" ? "update_deal_queue" : "persist_deals", batchKind: kind, batchKey: key, messageIds: published.map(item => item.messageId) });
    }
  }
  return {
    batchKey: key, kind, verified: verified.length, recent: recent.length,
    saved: published.reduce((count, item) => count + item.count, 0),
    published, sourceErrors: gathered.errors || []
  };
}
function startDealScheduler(options, { intervalMs = 60_000, retryAfterFailureMs = 2 * 60_000 } = {}) {
  let busy = false;
  let nextAttemptAt = 0;
  let backoffKind = null;
  let activeDay = batchKey();
  const reportedFetchFailures = new Set();

  // Retry a failed edition quickly enough to fit inside its five-minute window.
  // Keep diagnostics quiet: emit one identical fetch-failure report per Cairo day,
  // while a changed source/status signature is still reported immediately.
  const scheduledOptions = {
    ...options,
    onError: async (error, details = {}) => {
      if (details.stage === "fetch") {
        const day = batchKey();
        if (day !== activeDay) {
          activeDay = day;
          reportedFetchFailures.clear();
        }
        const sourceErrors = (details.errors || [])
          .map(item => `${String(item.source || "unknown")}:${String(item.reason || "unknown")}`)
          .sort();
        const signature = `${day}|${String(error?.message || "fetch_error")}|${sourceErrors.join(",")}`;
        if (reportedFetchFailures.has(signature)) return;
        reportedFetchFailures.add(signature);
      }
      await options.onError?.(error, details);
    }
  };

  const timer = setInterval(async () => {
    const currentKind = newsletterKindAt();
    if (shouldResetDealBackoff(backoffKind, currentKind)) {
      nextAttemptAt = 0;
      backoffKind = null;
    }
    if (busy || Date.now() < nextAttemptAt) return;
    busy = true;
    // Associate backoff with the edition that started this attempt, not the
    // wall-clock hour when a slow request happens to finish.
    const attemptKind = currentKind;
    try {
      const result = await publishDailyDeals(scheduledOptions);
      if (shouldBackoffAfterDealAttempt(result)) {
        nextAttemptAt = Date.now() + retryAfterFailureMs;
        backoffKind = attemptKind;
      } else {
        nextAttemptAt = 0;
        backoffKind = null;
      }
    } catch (error) {
      nextAttemptAt = Date.now() + retryAfterFailureMs;
      backoffKind = attemptKind;
      await scheduledOptions.onError?.(error, { stage: "scheduler_tick" });
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
function shouldBackoffAfterDealAttempt(result) {
  return Boolean(result?.skipped && ["no_deals", "all_recent_or_invalid", "message_too_long"].includes(result.reason));
}
function shouldResetDealBackoff(previousKind, currentKind) {
  return Boolean(previousKind && currentKind && previousKind !== currentKind);
}

module.exports = { cairoParts, batchKey, newsletterKindAt, isNewsletterWindow, selectNewsletterDeals, verifyProductUrl, verifyDeals, persistDeals, enqueueObservedDeals, loadQueuedDeals, updateQueuedDeals, publishDailyDeals, shouldBackoffAfterDealAttempt, shouldResetDealBackoff, startDealScheduler };
