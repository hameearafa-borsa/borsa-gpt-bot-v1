"use strict";

const crypto = require("node:crypto");

const CATALOG_REGION = "محافظة القاهرة";
const CATALOG_STORES = Object.freeze({
  kazyon: { name: "كازيون", catalogSlug: "kazyon", region: CATALOG_REGION, url: "https://snapflyer.io/eg/downtown/stores/kazyon" },
  bim: { name: "BIM", catalogSlug: "bim", region: CATALOG_REGION, url: "https://snapflyer.io/eg/downtown/stores/bim" },
  metro_market: { name: "مترو ماركت", catalogSlug: "metro-market", region: CATALOG_REGION, url: "https://snapflyer.io/eg/downtown/stores/metro-market?lang=en" }
});

const RELEVANT_CATEGORIES = Object.freeze([
  "detergent", "paper", "personal_care"
]);

const RELEVANT_TERMS = /detergent|cleaning|home|personal care|paper|tissue|wipes|shampoo|soap|laundry|dishwash|منظف|تنظيف|مسحوق|غسيل|مناديل|ورقي|شامبو|صابون|عناية|كلور|مطهر|حفاض/i;

function normalizeText(value) {
  return String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\s+/g, " ").trim();
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeCatalogUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "snapflyer.io" ||
        url.username || url.password || (url.port && url.port !== "443")) return null;
    return url.href;
  } catch {
    return null;
  }
}

function catalogUrlBelongsToStore(raw, storeKey) {
  const store = CATALOG_STORES[storeKey];
  const safeUrl = safeCatalogUrl(raw);
  if (!store || !safeUrl) return false;
  const segments = new URL(safeUrl).pathname.split("/").filter(Boolean);
  const offersIndex = segments.findIndex(segment => segment.toLowerCase() === "offers");
  return offersIndex >= 0 &&
    segments[offersIndex + 1]?.toLowerCase() === store.catalogSlug;
}

/**
 * Extracts store flyer links from a SnapFlyer store listing page.
 * It deliberately records flyer title/date metadata only; product selection
 * must come from extracted offer records, not assumptions based on flyer title.
 */
function extractCatalogs(html, storeKey) {
  const store = CATALOG_STORES[storeKey];
  if (!store || typeof html !== "string") return [];
  const results = [];
  const anchors = [...html.matchAll(/<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)];
  for (const match of anchors) {
    let resolvedUrl;
    try {
      resolvedUrl = new URL(match[2], store.url).href;
    } catch {
      continue;
    }
    const href = safeCatalogUrl(resolvedUrl);
    if (!href || !catalogUrlBelongsToStore(href, storeKey)) continue;
    const title = normalizeText(match[4]);
    if (!title || title.length < 5) continue;
    const context = normalizeText(match[1] + " " + match[3] + " " + match[4]);
    const dateMatch = context.match(/(\d{1,2}\s+[A-Za-z]{3}\s*(?:-|–)\s*\d{1,2}\s+[A-Za-z]{3}|\d{1,2}\s*[-–]\s*\d{1,2}\s+[A-Za-z]{3})/i);
    const displayedDateRange = dateMatch ? dateMatch[1] : null;
    // Include the validity range so a reused URL/title with changed dates is a new edition.
    results.push({
      store: storeKey,
      storeName: store.name,
      region: store.region,
      title: title.slice(0, 180),
      url: href,
      displayedDateRange,
      fingerprint: stableHash(storeKey + "|" + href + "|" + (displayedDateRange || ""))
    });
  }
  const unique = new Map();
  for (const item of results) if (!unique.has(item.url)) unique.set(item.url, item);
  return [...unique.values()];
}

function isRelevantOffer(offer) {
  const title = String(offer?.title || "");
  const category = String(offer?.category || "").toLowerCase();
  return RELEVANT_CATEGORIES.includes(category) || RELEVANT_TERMS.test(title);
}

function changedCatalogs(previousFingerprints, currentCatalogs) {
  const previous = new Set(previousFingerprints || []);
  return (currentCatalogs || []).filter(c => c && c.fingerprint && !previous.has(c.fingerprint));
}

/**
 * Persist catalog versions. The first observation establishes a quiet baseline;
 * only later unseen fingerprints for the same store+URL become pending notices.
 * The database unique constraint makes concurrent pollers idempotent.
 */
async function persistCatalogSnapshots(pool, catalogs) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("persistCatalogSnapshots requires a PostgreSQL pool");
  const result = { baseline: 0, changed: 0, unchanged: 0 };
  const storeHadHistory = new Map();
  for (const catalog of catalogs || []) {
    if (!catalog || !CATALOG_STORES[catalog.store] || !safeCatalogUrl(catalog.url) || !catalog.fingerprint || !catalog.title) continue;
    const latest = await pool.query(
      "SELECT fingerprint FROM catalog_newsletter_snapshots WHERE store_key=$1 AND catalog_url=$2 ORDER BY last_seen_at DESC, id DESC LIMIT 1",
      [catalog.store, catalog.url]
    );
    if (!latest.rows.length) {
      if (!storeHadHistory.has(catalog.store)) {
        const storeHistory = await pool.query(
          "SELECT id FROM catalog_newsletter_snapshots WHERE store_key=$1 LIMIT 1",
          [catalog.store]
        );
        storeHadHistory.set(catalog.store, storeHistory.rows.length > 0);
      }
      const isFirstObservationForStore = !storeHadHistory.get(catalog.store);
      await pool.query(
        "INSERT INTO catalog_newsletter_snapshots(store_key,catalog_url,fingerprint,title,region,displayed_date_range,status) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(store_key,catalog_url,fingerprint) DO NOTHING",
        [catalog.store, catalog.url, catalog.fingerprint, catalog.title, catalog.region || CATALOG_REGION, catalog.displayedDateRange || null, isFirstObservationForStore ? "ignored" : "pending"]
      );
      if (isFirstObservationForStore) result.baseline++;
      else result.changed++;
      continue;
    }
    if (latest.rows[0].fingerprint === catalog.fingerprint) {
      await pool.query(
        "UPDATE catalog_newsletter_snapshots SET last_seen_at=NOW() WHERE store_key=$1 AND catalog_url=$2 AND fingerprint=$3",
        [catalog.store, catalog.url, catalog.fingerprint]
      );
      result.unchanged++;
      continue;
    }
    const inserted = await pool.query(
      "INSERT INTO catalog_newsletter_snapshots(store_key,catalog_url,fingerprint,title,region,displayed_date_range,status) VALUES($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT(store_key,catalog_url,fingerprint) DO NOTHING RETURNING id",
      [catalog.store, catalog.url, catalog.fingerprint, catalog.title, catalog.region || CATALOG_REGION, catalog.displayedDateRange || null]
    );
    if (inserted.rowCount) result.changed++;
    else result.unchanged++;
  }
  return result;
}

async function listPendingCatalogSnapshots(pool, limit = 20) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("listPendingCatalogSnapshots requires a PostgreSQL pool");
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const r = await pool.query(
    "SELECT id,store_key,catalog_url,fingerprint,title,region,displayed_date_range,first_seen_at FROM catalog_newsletter_snapshots WHERE status='pending' ORDER BY first_seen_at,id LIMIT $1",
    [safeLimit]
  );
  return r.rows;
}

async function markCatalogSnapshot(pool, id, status, error = null) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("markCatalogSnapshot requires a PostgreSQL pool");
  if (!["published", "ignored", "failed"].includes(status)) throw new TypeError("invalid catalog snapshot status");
  const r = await pool.query(
    "UPDATE catalog_newsletter_snapshots SET status=$2, published_at=CASE WHEN $2='published' THEN NOW() ELSE published_at END, last_error=$3 WHERE id=$1 AND status='pending' RETURNING id",
    [id, status, error ? String(error).slice(0, 500) : null]
  );
  return r.rowCount === 1;
}

function formatCatalogNotice(snapshot) {
  const store = CATALOG_STORES[snapshot?.store_key];
  const url = safeCatalogUrl(snapshot?.catalog_url);
  if (!store || !url) throw new TypeError("invalid catalog snapshot");
  const date = snapshot.displayed_date_range ? `\nالفترة الظاهرة: ${normalizeText(snapshot.displayed_date_range)}` : "";
  return `🛒 تحديث كتالوج ${store.name}\n📍 النطاق الجغرافي: ${snapshot.region || CATALOG_REGION}\n\n${normalizeText(snapshot.title)}${date}\n\nرابط الكتالوج: ${url}`;
}

module.exports = {
  CATALOG_REGION,
  CATALOG_STORES,
  RELEVANT_CATEGORIES,
  normalizeText,
  stableHash,
  safeCatalogUrl,
  catalogUrlBelongsToStore,
  extractCatalogs,
  isRelevantOffer,
  changedCatalogs,
  persistCatalogSnapshots,
  listPendingCatalogSnapshots,
  markCatalogSnapshot,
  formatCatalogNotice
};
