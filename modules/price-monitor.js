"use strict";

const { extractPriceCandidates, commercialMetrics, fingerprint, productIdentityKey, classifyObservationChange } = require("./price-intelligence");
const { resolve } = require("../core/product-registry");
const { identityKey } = require("./price-review");

function isOwnMessage({ botUserId, fromId }) { return botUserId != null && String(botUserId) === String(fromId); }
function isBulkPriceList(text) {
  const source = String(text || "").trim();
  if (!source) return false;
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // Count prices anywhere in a row: common Telegram formats put pack counts
  // after the price (e.g. "٤٩٠ج ٤ق"), so an end-anchored match misses them.
  const pricedRows = lines.filter(line => {
    const asciiLine = line.replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
      .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
    return /\d+(?:[.,]\d+)?\s*(?:جنيه|ج|EGP)(?=\s|$)/iu.test(asciiLine) ||
      /(?:جمله|جملة|مستهلك|قطاعي)\s*[:：]?\s*\d+[.,]?\d*/iu.test(asciiLine);
  }).length;
  if (lines.length >= 8 && pricedRows >= 5) return true;

  // Telegram messages may contain a whole catalog pasted as one long paragraph.
  // Detect repeated explicit currency amounts before the single-product monitor sees it.
  const currencyPrices = [...source.matchAll(/(?:^|[\s:|])\d+(?:[.,]\d+)?\s*(?:جنيه|ج|EGP)(?=$|[\s|])/giu)].length;
  const hasCatalogContext = /(?:أسعار|اسعار)\s*(?:شركة|شركه)|(?:قائمة|قائمه)\s*أسعار|(?:جملة|جمله)\s+.{0,40}(?:منتجات|أصناف|اصناف)/iu.test(source);
  return source.length >= 500 && currencyPrices >= 8 && (hasCatalogContext || currencyPrices >= 12);
}

function isEligibleMessage({ chatType, text, isLogChannel, isCommand, ownMessage }) {
  return ["group", "supergroup"].includes(chatType) &&
    !isLogChannel && !isCommand && !ownMessage &&
    Boolean(String(text || "").trim()) && !isBulkPriceList(text);
}

async function observe({ pool, message, merchantId = null, registry }) {
  const text = message.text || message.caption || "";
  const candidates = extractPriceCandidates(text);
  const accepted = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (candidate.price_kind === "retail") continue;
    const match = resolve(candidate.product_text, registry);
    const row = {
      ...candidate,
      ...commercialMetrics(candidate),
      merchant_id: merchantId,
      registry_match: match.matched,
      registry_confidence: match.confidence,
      brand_key: match.brand?.key || null,
    };
    row.product_identity_key = productIdentityKey(row);
    // An explicitly approved product identity prevents repeat review based on the name alone.
    // Other ambiguities (multiple prices, unknown price kind) still remain pending.
    let previouslyReviewed = false;
    if (pool && !match.matched && candidate.confidence >= 0.8 && candidate.price_kind === "wholesale") {
      const known = await pool.query(
        "SELECT 1 FROM reviewed_price_products WHERE identity_key=$1 LIMIT 1",
        [identityKey(row)]
      );
      previouslyReviewed = known.rowCount > 0;
    }
    row.confidence = Math.min(candidate.confidence, match.matched || previouslyReviewed ? 0.98 : 0.45);
    row.decision = row.confidence >= 0.8 && row.price_kind === "wholesale" ? "accepted" : "pending";
    const fp = fingerprint(row);
    if (seen.has(fp)) continue;
    seen.add(fp);
    accepted.push(row);
  }

  const savedRows = [];
  if (!pool) return { accepted, saved: 0, savedRows, silent: true };
  for (const row of accepted) {
    const duplicate = await pool.query(
      `SELECT 1 FROM price_observations WHERE source_chat_id=$1 AND source_message_id=$2 AND raw_text=$3 LIMIT 1`,
      [message.chatId || null, message.messageId || null, row.raw_line]
    );
    if (duplicate.rowCount) continue;
    if (row.decision === "accepted") {
      const history = await pool.query(
        `SELECT product_identity_key, brand_key, price_kind, package_sale_price, weight_g, volume_ml,
                pack_count, offer_extra_weight_g, package_type
         FROM price_observations
         WHERE price_kind=$2 AND decision='accepted'
           AND (product_identity_key=$1 OR (product_identity_key IS NULL AND product_text=$3))
         ORDER BY observed_at DESC, id DESC LIMIT 1`,
        [row.product_identity_key, row.price_kind, row.product_text]
      );
      row.change_type = classifyObservationChange(history.rows?.[0] || null, row);
    } else {
      row.change_type = null;
    }

    const inserted = await pool.query(
      `INSERT INTO price_observations
       (merchant_id,price_kind,package_sale_price,source_chat_id,source_message_id,source_user_id,raw_text,confidence,
        product_text,weight_g,volume_ml,pack_count,offer_extra_weight_g,decision,brand_key,package_type,product_identity_key,change_type,
        listed_base_price,explicit_wholesale_label_price,price_selection_reason,needs_review)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
      [merchantId, row.price_kind, row.package_sale_price, message.chatId || null, message.messageId || null,
       message.userId || null, row.raw_line, row.confidence, row.product_text, row.weight_g, row.volume_ml,
       row.pack_count, row.offer_extra_weight_g, row.decision, row.brand_key, row.package_type,
       row.product_identity_key, row.change_type, row.listed_base_price ?? null,
       row.explicit_wholesale_label_price ?? null, row.price_selection_reason ?? null, Boolean(row.needs_review)]
    );
    savedRows.push({ id: inserted.rows[0].id, row });
  }
  return { accepted, saved: savedRows.length, savedRows, silent: true };
}

module.exports = { isOwnMessage, isBulkPriceList, isEligibleMessage, observe };
