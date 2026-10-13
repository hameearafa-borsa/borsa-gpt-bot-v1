"use strict";

const crypto = require("node:crypto");
const { normalizeArabic } = require("../core/normalization");

const ALLOWED = new Set(["detergent", "paper", "personal_care"]);

function digest(parts) {
  return crypto.createHash("sha256").update(parts.map(x => normalizeArabic(x == null ? "" : x)).join("|")).digest("hex");
}

// Identity of a particular price/discount observation. Intentionally changes when
// price, URL, or discount changes; this remains the unique observation key.
function dealFingerprint(deal) {
  return digest([deal.merchant, deal.title, deal.url, deal.price, deal.discount_pct, deal.category]);
}

// Conservative product identity for weekly duplicate suppression. Prefer a stable
// retailer product ID when one is present in the URL; otherwise use merchant +
// normalized title + category. Pack/size wording in the title is preserved, so
// different sizes are not silently merged.
function dealProductFingerprint(deal) {
  const merchant = normalizeArabic(deal.merchant || "");
  const category = normalizeArabic(deal.category || "");
  let url = "";
  try { url = new URL(String(deal.url || "")).href; } catch {}
  const host = (() => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } })();
  let retailerId = "";
  try {
    const u = new URL(url);
    if (/amazon\.eg$/.test(host)) retailerId = (u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i) || [])[1] || "";
    else if (/jumia\.com\.eg$/.test(host)) retailerId = (u.pathname.match(/-([A-Z0-9]{6,})(?:\.html)?$/i) || [])[1] || "";
    else if (/noon\.com$/.test(host)) retailerId = (u.pathname.match(/\/([A-Z0-9]{6,})(?:\.html)?$/i) || [])[1] || "";
  } catch {}
  if (retailerId) return digest([host, retailerId, category]);
  return digest([merchant || host, deal.title, category]);
}

function validateDeal(deal) {
  const category = String(deal.category || "").trim();
  if (!ALLOWED.has(category)) return { ok: false, reason: "category_not_allowed" };
  if (!String(deal.title || "").trim()) return { ok: false, reason: "missing_title" };
  if (!String(deal.url || "").trim()) return { ok: false, reason: "missing_url" };
  if (!(Number(deal.price) > 0)) return { ok: false, reason: "missing_price" };
  return { ok: true, fingerprint: dealFingerprint(deal), productFingerprint: dealProductFingerprint(deal) };
}

async function isRecentDuplicate(pool, fingerprint, days = 7, productFingerprint = null) {
  if (!pool) return false;
  const safeDays = Number(days);
  if (!Number.isFinite(safeDays) || safeDays <= 0 || safeDays > 365) throw new Error("days must be between 0 and 365");
  const r = await pool.query(
    `SELECT 1 FROM deal_observations
     WHERE observed_at > NOW() - ($3::double precision * INTERVAL '1 day')
       AND (fingerprint=$1 OR ($2::text IS NOT NULL AND product_fingerprint=$2))
     LIMIT 1`,
    [fingerprint, productFingerprint, safeDays]
  );
  return r.rowCount > 0;
}

module.exports = { ALLOWED, dealFingerprint, dealProductFingerprint, validateDeal, isRecentDuplicate };
