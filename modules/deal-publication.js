"use strict";
const { validateDeal, isRecentDuplicate } = require("./deals");

const TARGETS = Object.freeze({ detergent: 5, paper: 5, personal_care: 5 });
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
    if (await isRecentDuplicate(pool, check.fingerprint, days, check.productFingerprint)) continue;
    output.push({ ...deal, fingerprint: check.fingerprint, product_fingerprint: check.productFingerprint, score: scoreDeal(deal) });
  }
  return output;
}
function formatNewsletterMessage(deals, title, maxLength = 3900) {
  const safeTitle = String(title || "عروض بورصة المنظفات").slice(0, 120);
  const header = [`🛍️ ${safeTitle}`, "بورصة المنظفات لأصحاب المحلات", ""];
  const footer = "مدعوم بتقنيات ChatGPT";
  const items = [];
  const blocks = [];
  const render = current => [...header, ...current.flatMap((block, i) => [...block.map((line, j) => j === 0 ? `${i + 1}) ${line}` : line), ""]), footer].join("\n");
  for (const d of deals || []) {
    const block = [String(d.title || "منتج").slice(0, 180)];
    if (d.merchant) block.push(`🏪 المتجر: ${String(d.merchant).slice(0, 80)}`);
    block.push(`💰 السعر: ${Number(d.price).toFixed(2)} جنيه`);
    if (Number(d.old_price) > Number(d.price)) block.push(`قبل الخصم: ${Number(d.old_price).toFixed(2)} جنيه`);
    block.push(`🔗 ${String(d.url || "")}`);
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
