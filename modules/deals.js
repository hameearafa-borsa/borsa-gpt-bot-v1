"use strict";

const crypto = require("node:crypto");
const { normalizeArabic } = require("../core/normalization");

const ALLOWED = new Set(["detergent", "paper", "personal_care"]);

function dealFingerprint(deal) {
  const base = [deal.merchant, deal.title, deal.url, deal.price, deal.discount_pct, deal.category]
    .map((x) => normalizeArabic(x == null ? "" : x))
    .join("|");
  return crypto.createHash("sha256").update(base).digest("hex");
}

function validateDeal(deal) {
  const category = String(deal.category || "").trim();
  if (!ALLOWED.has(category)) return { ok: false, reason: "category_not_allowed" };
  if (!String(deal.title || "").trim()) return { ok: false, reason: "missing_title" };
  if (!String(deal.url || "").trim()) return { ok: false, reason: "missing_url" };
  if (!(Number(deal.price) > 0)) return { ok: false, reason: "missing_price" };
  return { ok: true, fingerprint: dealFingerprint(deal) };
}

async function isRecentDuplicate(pool, fingerprint, days = 7) {
  if (!pool) return false;
  const r = await pool.query(
    `SELECT 1 FROM deal_observations WHERE fingerprint=$1 AND observed_at > NOW() - ($2 || ' days')::interval LIMIT 1`,
    [fingerprint, String(days)]
  );
  return r.rowCount > 0;
}

module.exports = { ALLOWED, dealFingerprint, validateDeal, isRecentDuplicate };
