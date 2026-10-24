"use strict";
const { collectDealCandidates } = require("./deal-sources");
const { filterRecentDeals, distributeDeals } = require("./deal-publication");
const { dealFingerprint, dealProductFingerprint, validateDeal } = require("./deals");

function cairoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type,p.value]));
}
function batchKey(date = new Date()) { const p = cairoParts(date); return `${p.year}-${p.month}-${p.day}`; }
function newsletterKindAt(date = new Date()) { const p = cairoParts(date); const hour = Number(p.hour); if (hour === 17) return "amazon"; if (hour === 18) return "other_sites"; return null; }
function isNewsletterWindow(date = new Date()) { return newsletterKindAt(date) !== null; }

async function verifyProductUrl(raw, { fetchImpl = globalThis.fetch, timeoutMs = 7000, maxRedirects = 5 } = {}) {
  const allowedHosts = new Set(["www.amazon.eg", "amazon.eg", "www.jumia.com.eg", "jumia.com.eg", "www.noon.com", "noon.com"]);
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
    results.forEach((r,j) => { if (r.ok) output.push({ ...group[j], url: r.finalUrl, verified_url: true }); });
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
async function publishDailyDeals({ pool, telegram, chatId, fetcher = collectDealCandidates, verify = verifyDeals, now = new Date(), onError = async () => {} }) {
  if (!pool || !telegram || !chatId) return { skipped: true, reason: "database_telegram_or_deals_chat_missing" };
  const kind = newsletterKindAt(now);
  if (!kind) return { skipped: true, reason: "outside_newsletter_hours" };
  const key = batchKey(now);
  const existing = await pool.query("SELECT channel_kind,status FROM deal_publications WHERE batch_key=$1", [key]);
  if (existing.rows.some(r => r.channel_kind === kind && r.status === "published")) return { skipped: true, reason: "already_published", batchKey: key, kind };
  const gathered = await fetcher();
  if (!gathered.deals?.length) {
    await onError(new Error("No validated deal candidates; newsletter not published"), { stage: "fetch", errors: gathered.errors || [] });
    return { skipped: true, reason: "no_deals", sourceErrors: gathered.errors || [] };
  }
  const verified = await verify(gathered.deals);
  const recent = await filterRecentDeals(pool, verified, 7);
  if (!recent.length) return { skipped: true, reason: "all_recent_or_invalid", sourceErrors: gathered.errors || [] };
  // Each of the two daily newsletters is capped at five products per category.
  // The 5 PM edition is Amazon-only; the 6 PM edition uses non-Amazon retailers.
  const isAmazon = d => { try { const host = new URL(d.url).hostname.toLowerCase(); return host === "www.amazon.eg" || host === "amazon.eg"; } catch { return false; } };
  // Balance each edition independently; balancing the combined pool first can let
  // Amazon products crowd out every candidate for the 6 PM edition.
  const editionPool = recent.filter(d => kind === "amazon" ? isAmazon(d) : !isAmazon(d));
  const balanced = distributeDeals(editionPool);
  const items = [...balanced.detergent, ...balanced.paper, ...balanced.personal_care];
  if (!items.length) {
    await onError(new Error("No validated deal candidates for scheduled newsletter"), { stage: "fetch", errors: gathered.errors || [], batchKind: kind });
    return { skipped: true, reason: "no_deals", kind, sourceErrors: gathered.errors || [] };
  }
  const batches = [{
    kind,
    items,
    title: kind === "amazon"
      ? "عروض أمازون للمنظفات والورقيات والعناية"
      : "عروض المتاجر الأخرى المختارة"
  }];
  const published = [];
  for (const batch of batches) {
    if (!batch.items.length) continue;
    const reservation = await pool.query(`INSERT INTO deal_publications(batch_key,channel_kind,chat_id,item_count,status)
      VALUES($1,$2,$3,$4,'prepared') ON CONFLICT(batch_key,channel_kind) DO NOTHING RETURNING id`, [key,batch.kind,chatId,batch.items.length]);
    if (!reservation.rowCount) {
      const old = await pool.query("SELECT status FROM deal_publications WHERE batch_key=$1 AND channel_kind=$2", [key,batch.kind]);
      if (old.rows[0]?.status === "published") continue;
      // Do not auto-repeat a prepared/failed post; leave it for diagnosis and manual repair.
      continue;
    }
    const lines = [`🛍️ ${batch.title}`, "بورصة المنظفات لأصحاب المحلات", ""];
    for (const [i,d] of batch.items.entries()) {
      lines.push(`${i+1}. ${d.title}`, `🏪 ${d.merchant || "المتجر"}`, `💰 ${Number(d.price).toFixed(2)} جنيه`);
      if (Number(d.old_price) > Number(d.price)) lines.push(`قبل الخصم: ${Number(d.old_price).toFixed(2)} جنيه (${Number(d.discount_pct).toFixed(0)}%)`);
      lines.push(`🔗 ${d.url}`, "");
    }
    lines.push("مدعوم بتقنيات ChatGPT");
    try {
      const msg = await telegram.sendMessage(chatId, lines.join("\n").slice(0,3900), { disable_web_page_preview: true });
      await pool.query("UPDATE deal_publications SET status='published',published_at=NOW(),message_id=$1 WHERE id=$2", [msg.message_id,reservation.rows[0].id]);
      await persistDeals(pool, batch.items);
      published.push({ kind: batch.kind, count: batch.items.length });
    } catch (error) {
      await pool.query("UPDATE deal_publications SET status='failed' WHERE id=$1", [reservation.rows[0].id]).catch(()=>{});
      await onError(error, { stage: "publish", batchKind: batch.kind, batchKey: key });
    }
  }
  return { batchKey: key, verified: verified.length, recent: recent.length, saved: published.reduce((n,x) => n + x.count, 0), published, sourceErrors: gathered.errors || [] };
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
module.exports = { cairoParts, batchKey, newsletterKindAt, isNewsletterWindow, verifyProductUrl, verifyDeals, persistDeals, publishDailyDeals, startDealScheduler };
