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
  // Run only in the first five minutes after the scheduled hour. This tolerates
  // startup/timer jitter but prevents a late boot (e.g. 18:45) from launching
  // a newsletter at an arbitrary time. The database reservation still prevents duplicates.
  if (minute >= 0 && minute < 5 && hour === 17) return "amazon";
  if (minute >= 0 && minute < 5 && hour === 18) return "other_sites";
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
async function enqueueObservedDeals(pool, deals, source = "amazon", chatIds = []) {
  const saved = await persistDeals(pool, deals);
  const targets = [...new Set((chatIds || []).map(Number).filter(Number.isSafeInteger))];
  let queued = 0;
  for (const deal of deals || []) {
    const valid = validateDeal(deal);
    if (!valid.ok) continue;
    for (const chatId of targets) {
      await pool.query(
        `INSERT INTO deal_publication_queue(fingerprint,chat_id,source,status,first_queued_at,last_observed_at,updated_at)
         VALUES($1,$2,$3,'queued',NOW(),NOW(),NOW())
         ON CONFLICT(fingerprint,chat_id) DO UPDATE
         SET first_queued_at=CASE
               WHEN deal_publication_queue.status='published'
                AND deal_publication_queue.last_observed_at < NOW() - INTERVAL '7 days'
               THEN NOW() ELSE deal_publication_queue.first_queued_at END,
             last_observed_at=NOW(),updated_at=NOW(),
             status=CASE
               WHEN deal_publication_queue.status='published'
                AND deal_publication_queue.last_observed_at >= NOW() - INTERVAL '7 days'
               THEN 'published'
               ELSE 'queued'
             END`,
        [valid.fingerprint, chatId, source]
      );
      queued++;
    }
  }
  return { saved, queued };
}
async function loadQueuedDeals(pool, source = "amazon", chatId, limit = 15) {
  const result = await pool.query(
    `SELECT o.merchant,o.title,o.url,o.category,o.price,o.old_price,o.discount_pct,
            o.fingerprint,o.product_fingerprint,q.first_queued_at,q.last_observed_at
     FROM deal_publication_queue q
     JOIN deal_observations o ON o.fingerprint=q.fingerprint
     WHERE q.source=$1 AND q.chat_id=$2 AND q.status='queued'
     ORDER BY q.first_queued_at ASC,q.fingerprint ASC
     LIMIT $3`,
    [source, chatId, limit]
  );
  return result.rows || [];
}
async function markQueuedDealsPublished(pool, deals, chatId) {
  const fingerprints = [...new Set((deals || []).map(deal => deal.fingerprint).filter(Boolean))];
  if (!fingerprints.length) return 0;
  const result = await pool.query(
    `UPDATE deal_publication_queue
     SET status='published',published_at=NOW(),updated_at=NOW()
     WHERE fingerprint=ANY($1::text[]) AND chat_id=$2 AND status='queued'`,
    [fingerprints, chatId]
  );
  return result.rowCount || 0;
}
async function reconcilePublishedQueue(pool, chatId, itemCount) {
  const limit = Math.max(0, Number(itemCount) || 0);
  if (!limit) return 0;
  const result = await pool.query(
    `WITH queued AS (
       SELECT fingerprint
       FROM deal_publication_queue
       WHERE source='amazon' AND chat_id=$1 AND status='queued'
       ORDER BY first_queued_at ASC,fingerprint ASC
       LIMIT $2
     )
     UPDATE deal_publication_queue q
     SET status='published',published_at=COALESCE(q.published_at,NOW()),updated_at=NOW()
     FROM queued
     WHERE q.fingerprint=queued.fingerprint AND q.chat_id=$1 AND q.status='queued'`,
    [chatId, limit]
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

async function publishDailyDeals({ pool, telegram, chatId, chatIds, fetcher = collectDealCandidates, verify = verifyDeals, now = new Date(), onError = async () => {} }) {
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
    "SELECT channel_kind,status,chat_id,item_count FROM deal_publications WHERE batch_key=$1 AND channel_kind=$2 AND chat_id = ANY($3::bigint[])",
    [key, kind, targetChatIds]
  );
  if (kind === "amazon") {
    // A prior Telegram send may have succeeded while the queue-status update failed.
    // The published batch record is the durable confirmation; reconcile its FIFO items
    // instead of sending the same newsletter again.
    for (const row of existing.rows) {
      if (row.channel_kind === "amazon" && row.status === "published") {
        await reconcilePublishedQueue(pool, Number(row.chat_id), row.item_count);
      }
    }
  }
  const reservedChats = new Set(existing.rows.filter(row => row.channel_kind === kind && row.status !== "failed").map(row => Number(row.chat_id)));
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
  const gathered = await fetcher({ edition: kind });
  if (!gathered.deals?.length && kind !== "amazon") {
    await onError(new Error("No validated deal candidates; newsletter not published"), { stage: "fetch", errors: gathered.errors || [], sourceStats: gathered.sourceStats || [], sourceSummary: gathered.sourceSummary || [], sourceCount: gathered.sourceCount ?? null, batchKind: kind, batchKey: key });
    return { skipped: true, reason: "no_deals", sourceErrors: gathered.errors || [], sourceStats: gathered.sourceStats || [], sourceSummary: gathered.sourceSummary || [], sourceCount: gathered.sourceCount ?? null };
  }
  const verified = await verify(gathered.deals || []);
  const itemsByChat = new Map();
  let recent = [];
  let items = [];
  if (kind === "amazon") {
    // Persist every validated observation and enqueue it per destination before Telegram is called.
    // Failed sends leave the queue rows untouched for the next scheduled attempt.
    try {
      await enqueueObservedDeals(pool, verified, "amazon", targetChatIds);
    } catch (error) {
      await onError(error, { stage: "persist_deals", batchKind: kind, batchKey: key });
      return { skipped: true, reason: "persist_failed", sourceErrors: gathered.errors || [] };
    }
    for (const targetId of unreservedTargets) {
      const queued = await loadQueuedDeals(pool, "amazon", targetId, 15);
      itemsByChat.set(targetId, queued);
      recent.push(...queued);
    }
    recent = [...new Map(recent.map(deal => [deal.fingerprint, deal])).values()];
    items = [...new Map([...itemsByChat.values()].flat().map(deal => [deal.fingerprint, deal])).values()];
  } else {
    recent = await filterRecentDeals(pool, verified, 7);
    items = selectNewsletterDeals(recent, kind);
    for (const targetId of unreservedTargets) itemsByChat.set(targetId, items);
  }
  if (!items.length) {
    if (kind === "amazon" && !gathered.deals?.length) {
      await onError(new Error("No validated deal candidates; newsletter not published"), { stage: "fetch", errors: gathered.errors || [], sourceStats: gathered.sourceStats || [], sourceSummary: gathered.sourceSummary || [], sourceCount: gathered.sourceCount ?? null, batchKind: kind, batchKey: key });
      return { skipped: true, reason: "no_deals", sourceErrors: gathered.errors || [] };
    }
    return { skipped: true, reason: kind === "amazon" ? "amazon_queue_empty" : "all_recent_or_invalid", sourceErrors: gathered.errors || [] };
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
    const targetItems = itemsByChat.get(targetId) || [];
    const formatted = formatNewsletterMessage(targetItems, title);
    const formattedItems = formatted.items;
    if (!formattedItems.length) {
      await onError(new Error("No complete product blocks fit in the Telegram newsletter limit"), { stage: "format", batchKind: kind, batchKey: key, chatId: targetId });
      continue;
    }
    const reservation = await pool.query(
      "INSERT INTO deal_publications(batch_key,channel_kind,chat_id,item_count,status) VALUES($1,$2,$3,$4,'prepared') ON CONFLICT(batch_key,channel_kind,chat_id) DO UPDATE SET item_count=EXCLUDED.item_count,status='prepared',message_id=NULL,published_at=NULL WHERE deal_publications.status='failed' RETURNING id",
      [key, kind, targetId, formattedItems.length]
    );
    if (!reservation.rowCount) continue;
    let msg;
    try {
      msg = await telegram.sendMessage(targetId, formatted.text, { disable_web_page_preview: true });
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
    if (kind === "amazon") {
      try {
        await markQueuedDealsPublished(pool, formattedItems, targetId);
      } catch (error) {
        await onError(error, { stage: "mark_queue_published", batchKind: kind, batchKey: key, messageId: msg.message_id, chatId: targetId });
      }
    }
  }
  if (kind !== "amazon" && published.length) {
    try {
      await persistDeals(pool, itemsByChat.get(published[0].chatId) || []);
    } catch (error) {
      await onError(error, { stage: "persist_deals", batchKind: kind, batchKey: key, messageIds: published.map(item => item.messageId) });
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

module.exports = { cairoParts, batchKey, newsletterKindAt, isNewsletterWindow, selectNewsletterDeals, verifyProductUrl, verifyDeals, persistDeals, enqueueObservedDeals, loadQueuedDeals, markQueuedDealsPublished, reconcilePublishedQueue, publishDailyDeals, shouldBackoffAfterDealAttempt, shouldResetDealBackoff, startDealScheduler };
