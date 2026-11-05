"use strict";
const { validateDeal, isRecentDuplicate } = require("./deals");

const TARGETS = Object.freeze({ detergent: 10, paper: 10, personal_care: 10 });
function scoreDeal(deal) {
  const discount = Math.max(0, Math.min(90, Number(deal.discount_pct) || 0));
  const hasOldPrice = Number(deal.old_price) > Number(deal.price) && Number(deal.old_price) > 0;
  const verified = deal.verified_url === true ? 10 : 0;
  const priceEvidence = Number(deal.price) > 0 ? 5 : 0;
  const merchantEvidence = String(deal.merchant || "").trim() ? 5 : 0;
  const freshness = Number(deal.freshness_score) || 0;
  return Math.round(discount * 0.55 + (hasOldPrice ? 12 : 0) + verified + priceEvidence + merchantEvidence + Math.max(0, Math.min(10, freshness)));
}
function rankDeals(deals) {
  return deals.map(d => ({ ...d, score: scoreDeal(d) })).sort((a,b) => b.score - a.score);
}
function distributeDeals(deals, target = TARGETS) {
  const ranked = rankDeals(deals);
  const selected = { detergent: [], paper: [], personal_care: [] };
  const deferred = [];
  const seen = new Set();
  const totalTarget = Object.values(target).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0);
  for (const deal of ranked) {
    const check = validateDeal(deal);
    if (!check.ok || seen.has(check.fingerprint)) continue;
    seen.add(check.fingerprint);
    const category = deal.category;
    if (!selected[category]) continue;
    const item = { ...deal, fingerprint: check.fingerprint };
    if (selected[category].length < Math.max(0, Number(target[category]) || 0)) selected[category].push(item);
    else deferred.push(item);
  }
  // Category targets are preferred allocations, not hard exclusions.
  // If one category is short, fill the remaining edition capacity from the
  // highest-ranked eligible offers in the other categories.
  const selectedFingerprints = new Set(Object.values(selected).flat().map(deal => deal.fingerprint));
  for (const deal of deferred) {
    const categoryTotal = Object.values(selected).reduce((sum, items) => sum + items.length, 0);
    if (categoryTotal >= totalTarget) break;
    if (selectedFingerprints.has(deal.fingerprint)) continue;
    selected[deal.category].push(deal);
    selectedFingerprints.add(deal.fingerprint);
  }
  return { ...selected, total: Object.values(selected).reduce((n,a)=>n+a.length,0), targetTotal: totalTarget };
}
async function filterRecentDeals(pool, deals, days = 7) {
  const output = [];
  for (const deal of deals) {
    const check = validateDeal(deal);
    if (!check.ok) continue;
    if (await isRecentDuplicate(pool, check.fingerprint, days, check.productFingerprint)) continue;
    output.push({ ...deal, fingerprint: check.fingerprint, product_fingerprint: check.productFingerprint, score: scoreDeal(deal) });
  }
  return output;
}
function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function formatNewsletterMessage(deals, title, maxLength = 3900) {
  const safeTitle = escapeHtml(String(title || "عروض بورصة المنظفات").slice(0, 120));
  const header = [`🛍️ ${safeTitle}`, "بورصة المنظفات لأصحاب المحلات", ""];
  const footer = "مدعوم بتقنيات ChatGPT";
  const items = [];
  const blocks = [];
  const render = current => [...header, ...current.flatMap((block, i) => [...block.map((line, j) => j === 0 ? `${i + 1}) ${line}` : line), ""]), footer].join("\n");
  for (const d of deals || []) {
    const block = [escapeHtml(String(d.title || "منتج").slice(0, 180))];
    if (d.merchant) block.push(`🏪 المتجر: ${escapeHtml(String(d.merchant).slice(0, 80))}`);
    block.push(`💰 السعر: ${Number(d.price).toFixed(2)} جنيه`);
    if (Number(d.old_price) > Number(d.price)) block.push(`قبل الخصم: ${Number(d.old_price).toFixed(2)} جنيه`);
    if (d.url) block.push(`🔗 <a href="${escapeHtml(d.url)}">فتح العرض</a>`);
    const candidate = render([...blocks, block]);
    if (candidate.length > maxLength) continue;
    blocks.push(block);
    items.push(d);
  }
  return { text: render(blocks), items };
}
function buildNewsletter(deals, title) {
  return formatNewsletterMessage(deals, title).text;
}
module.exports = { TARGETS, scoreDeal, rankDeals, distributeDeals, filterRecentDeals, formatNewsletterMessage, buildNewsletter };
