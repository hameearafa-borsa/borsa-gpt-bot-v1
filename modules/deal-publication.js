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
  const seen = new Set();
  for (const deal of ranked) {
    const check = validateDeal(deal);
    if (!check.ok || seen.has(check.fingerprint)) continue;
    seen.add(check.fingerprint);
    const category = deal.category;
    if (selected[category].length < (target[category] || 0)) selected[category].push({ ...deal, fingerprint: check.fingerprint });
  }
  return { ...selected, total: Object.values(selected).reduce((n,a)=>n+a.length,0), targetTotal: Object.values(target).reduce((n,n2)=>n+n2,0) };
}
async function filterRecentDeals(pool, deals, days = 7) {
  const output = [];
  for (const deal of deals) {
    const check = validateDeal(deal);
    if (!check.ok) continue;
    if (await isRecentDuplicate(pool, check.fingerprint, days)) continue;
    output.push({ ...deal, fingerprint: check.fingerprint, score: scoreDeal(deal) });
  }
  return output;
}
function buildNewsletter(deals, title) {
  const safeTitle = String(title || "عروض بورصة المنظفات").slice(0, 120);
  const lines = [`🛍️ ${safeTitle}`, "بورصة المنظفات لأصحاب المحلات", ""];
  for (const [i,d] of deals.entries()) {
    lines.push(`${i+1}) ${String(d.title).slice(0,180)}`);
    if (d.merchant) lines.push(`🏪 المتجر: ${String(d.merchant).slice(0,80)}`);
    lines.push(`💰 السعر: ${Number(d.price).toFixed(2)} جنيه`);
    if (Number(d.old_price) > Number(d.price)) lines.push(`قبل الخصم: ${Number(d.old_price).toFixed(2)} جنيه`);
    lines.push(`🔗 ${d.url}`, "");
  }
  lines.push("مدعوم بتقنيات ChatGPT");
  return lines.join("\n").slice(0,3900);
}
module.exports = { TARGETS, scoreDeal, rankDeals, distributeDeals, filterRecentDeals, buildNewsletter };
