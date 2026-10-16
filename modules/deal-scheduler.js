"use strict";
const { collectDealCandidates } = require("./deal-sources");
const { filterRecentDeals, distributeDeals } = require("./deal-publication");
const { dealFingerprint, dealProductFingerprint, validateDeal } = require("./deals");

function cairoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type,p.value]));
}
function batchKey(date = new Date()) { const p = cairoParts(date); return `${p.year}-${p.month}-${p.day}`; }
function isNewsletterWindow(date = new Date()) { const p = cairoParts(date); return Number(p.hour) >= 17; }

async function verifyProductUrl(raw, { fetchImpl = globalThis.fetch, timeoutMs = 7000 } = {}) {
  let url;
  try { url = new URL(raw); } catch { return { ok: false, reason: "invalid_url" }; }
  const allowedHosts = new Set(["www.amazon.eg", "amazon.eg", "www.jumia.com.eg", "jumia.com.eg", "www.noon.com", "noon.com"]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.username || url.password) return { ok: false, reason: "host_not_allowed" };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if ([403, 405, 501].includes(response.status)) response = await fetchImpl(url, { method: "GET", redirect: "follow", signal: controller.signal, headers: { Range: "bytes=0-0" } });
    const final = new URL(response.url || url.href);
    if (final.protocol !== "https:" || !allowedHosts.has(final.hostname)) return { ok: false, reason: "redirect_host_not_allowed" };
    return { ok: response.status >= 200 && response.status < 400, status: response.status, finalUrl: final.href, reason: response.status >= 200 && response.status < 400 ? null : "http_error" };
  } catch (error) { return { ok: false, reason: error.name === "AbortError" ? "timeout" : "fetch_failed" }; }
  finally { clearTimeout(timer); }
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
  if (!isNewsletterWindow(now)) return { skipped: true, reason: "before_17_cairo" };
  const key = batchKey(now);
  const existing = await pool.query("SELECT channel_kind,status FROM deal_publications WHERE batch_key=$1", [key]);
  if (["amazon","other_sites","best_deals"].every(kind => existing.rows.some(r => r.channel_kind === kind && r.status === "published"))) return { skipped: true, reason: "already_published", batchKey: key };
  const gathered = await fetcher();
  if (!gathered.deals?.length) {
    const errors = gathered.errors || [];
    // Durable throttling avoids logging the same source failure every minute.
    const errorKey = errors
      .map(e => String(e.source || "unknown") + ":" + String(e.status || e.reason || e.code || "error"))
      .sort()
      .join("|")
      .slice(0, 400) || "no_validated_deals";
    let shouldNotify = true;
    try {
      const notice = await pool.query(
        "INSERT INTO deal_error_notifications(error_key, occurrences, last_notified_at) " +
        "VALUES($1, 1, NOW()) " +
        "ON CONFLICT(error_key) DO UPDATE SET " +
        "occurrences = deal_error_notifications.occurrences + 1, " +
        "last_notified_at = CASE " +
        "WHEN deal_error_notifications.last_notified_at <= NOW() - INTERVAL '30 minutes' THEN NOW() " +
        "ELSE deal_error_notifications.last_notified_at END " +
        "RETURNING last_notified_at = NOW() AS should_notify",
        [errorKey]
      );
      shouldNotify = Boolean(notice.rows[0]?.should_notify);
    } catch (error) {
      await onError(error, { stage: "error_notification_throttle", errorKey });
    }
    if (shouldNotify) {
      await onError(new Error("No validated deal candidates; newsletter not published"), {
        stage: "fetch", errors, errorKey
      });
    }
    return { skipped: true, reason: "no_deals", sourceErrors: errors, errorKey, notified: shouldNotify };
  }
  const verified = await verify(gathered.deals);
  const recent = await filterRecentDeals(pool, verified, 7);
  if (!recent.length) return { skipped: true, reason: "all_recent_or_invalid", sourceErrors: gathered.errors || [] };
  // Overall pool is category-balanced (10 detergents, 10 paper, 10 care when supply allows).
  const balanced = distributeDeals(recent);
  const ordered = [...balanced.detergent, ...balanced.paper, ...balanced.personal_care];
  const amazon = ordered.filter(d => /amazon\.eg/i.test(new URL(d.url).hostname)).slice(0, 10);
  const amazonKeys = new Set(amazon.map(d => d.fingerprint));
  const remaining = ordered.filter(d => !amazonKeys.has(d.fingerprint));
  const other = remaining.filter(d => !/amazon\.eg/i.test(new URL(d.url).hostname)).slice(0, 10);
  const otherKeys = new Set(other.map(d => d.fingerprint));
  const publishedKeys = new Set([...amazonKeys, ...otherKeys]);
  const best = ordered.filter(d => !publishedKeys.has(d.fingerprint)).sort((a,b) => (Number(b.discount_pct)||0) - (Number(a.discount_pct)||0)).slice(0, 10);
  const batches = [
    { kind: "amazon", items: amazon, title: "عروض أمازون للمنظفات والورقيات والعناية" },
    { kind: "other_sites", items: other, title: "عروض المتاجر الأخرى" },
    { kind: "best_deals", items: best, title: "أفضل العروض المختارة" }
  ];
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
function startDealScheduler(options, { intervalMs = 60_000 } = {}) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; busy = true;
    try { await publishDailyDeals(options); }
    catch (error) { await options.onError?.(error, { stage: "scheduler_tick" }); }
    finally { busy = false; }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
module.exports = { cairoParts, batchKey, isNewsletterWindow, verifyProductUrl, verifyDeals, persistDeals, publishDailyDeals, startDealScheduler };
