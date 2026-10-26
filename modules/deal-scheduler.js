"use strict";
const { collectDealCandidates } = require("./deal-sources");
const { filterRecentDeals, distributeDeals, formatNewsletterMessage } = require("./deal-publication");
const { dealFingerprint, dealProductFingerprint, validateDeal } = require("./deals");

function cairoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type,p.value]));
}
function batchKey(date = new Date()) { const p = cairoParts(date); return `${p.year}-${p.month}-${p.day}`; }
function newsletterKindAt(date = new Date()) { const p = cairoParts(date); const hour = Number(p.hour); if (hour === 17) return "amazon"; if (hour === 18) return "other_sites"; return null; }
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
  const allowedHosts = new Set(["www.amazon.eg", "amazon.eg", "www.jumia.com.eg", "jumia.com.eg", "www.noon.com", "noon.com", "www.carrefouregypt.com", "carrefouregypt.com"]);
  const safeUrl = value => {
    try {
      const u = new URL(value);
      if (u.protocol !== "https:" || !allowedHosts.has(u.hostname.toLowerCase()) || u.username || u.password || (u.port && u.port !== "443")) return null;
      return u;
    } catch { return null; }
  };
  let url = safeUrl(raw);
  if (!url) return { ok: false, reason: "host_not_allowed" };
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
        const next = safeUrl(new URL(location, url).href);
        if (!next) return { ok: false, reason: "redirect_host_not_allowed" };
        url = next;
        continue;
      }
      const ok = response.status >= 200 && response.status < 400;
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
async function resolveDealChatIds({ pool, chatId, chatIds }) {
  if (Array.isArray(chatIds)) return [...new Set(chatIds.map(Number).filter(Number.isSafeInteger))];
  // Explicit chatId is retained for tests and intentional single-group runs.
  if (chatId !== undefined && chatId !== null && Number.isSafeInteger(Number(chatId))) return [Number(chatId)];
  const r = await pool.query("SELECT chat_id FROM authorized_chats WHERE active=TRUE AND chat_type IN ('group','supergroup') ORDER BY chat_id");
  return [...new Set((r.rows || []).map(row => Number(row.chat_id)).filter(Number.isSafeInteger))];
}

async function publishDailyDeals({ pool, telegram, chatId, chatIds, fetcher = collectDealCandidates, verify = verifyDeals, now = new Date(), onError = async () => {} }) {
  if (!pool || !telegram) return { skipped: true, reason: "database_or_telegram_missing" };
  const targetChatIds = await resolveDealChatIds({ pool, chatId, chatIds });
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
  const gathered = await fetcher({ edition: kind });
  if (!gathered.deals?.length) {
    await onError(new Error("No validated deal candidates; newsletter not published"), { stage: "fetch", errors: gathered.errors || [] });
    return { skipped: true, reason: "no_deals", sourceErrors: gathered.errors || [] };
  }
  const verified = await verify(gathered.deals);
  const recent = await filterRecentDeals(pool, verified, 7);
  if (!recent.length) return { skipped: true, reason: "all_recent_or_invalid", sourceErrors: gathered.errors || [] };
  const items = selectNewsletterDeals(recent, kind);
  if (!items.length) {
    await onError(new Error("No validated deal candidates for scheduled newsletter"), { stage: "fetch", errors: gathered.errors || [], batchKind: kind });
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
  }

  // Persist each observed offer once after at least one Telegram send was confirmed.
  if (published.length) {
    try {
      await persistDeals(pool, formattedItems);
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
function startDealScheduler(options, { intervalMs = 60_000, retryAfterFailureMs = 15 * 60_000 } = {}) {
  let busy = false;
  let nextAttemptAt = 0;
  let activeDay = batchKey();
  const reportedFetchFailures = new Set();

  // A failed source query used to emit the same diagnostic every minute. Keep
  // trying periodically, but emit only one identical fetch-failure report per
  // Cairo day. A changed source/status signature is still reported immediately.
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
    if (busy || Date.now() < nextAttemptAt) return;
    busy = true;
    try {
      const result = await publishDailyDeals(scheduledOptions);
      if (result.reason === "no_deals") nextAttemptAt = Date.now() + retryAfterFailureMs;
      else nextAttemptAt = 0;
    } catch (error) {
      nextAttemptAt = Date.now() + retryAfterFailureMs;
      await scheduledOptions.onError?.(error, { stage: "scheduler_tick" });
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
module.exports = { cairoParts, batchKey, newsletterKindAt, isNewsletterWindow, selectNewsletterDeals, verifyProductUrl, verifyDeals, persistDeals, publishDailyDeals, startDealScheduler };
