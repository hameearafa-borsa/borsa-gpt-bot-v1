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
  // Company price lists often omit the currency marker after every amount (e.g.
  // "صنسيلك 350 مل عرض 76.25"). A clear catalog heading plus many numbered rows
  // is enough to classify the whole message as a catalog, without requiring "جنيه"
  // on every line. Keep the threshold high so ordinary single-product messages pass.
  const numericRows = lines.filter(line => {
    const asciiLine = line.replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
      .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
    return /\d/.test(asciiLine);
  }).length;
  if (hasCatalogContext && lines.length >= 12 && numericRows >= 8) return true;
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
  // Infer the commercial context from the whole post, not only from the line
  // containing the amount. Sellers often put "جملة" in a heading or on just
  // one line while listing several products. Explicit consumer wording wins.
  const hasExplicitWholesaleContext = /(?:جمله|جملة|كرتونه|كرتونة|فاتوره|فاتورة|تاجر|السعر الصافي بعد الخصم|صافي سعر القطعه|عدد القطع)/iu.test(text);
  const hasExplicitRetailContext = /(?:مستهلك|قطاعي|تجزئه|تجزئة|للمستهلك)/iu.test(text);
  const hasMultiProductContext = candidates.length >= 2 && !hasExplicitRetailContext;
  for (const candidate of candidates) {
    if (candidate.price_kind === "retail") continue;
    if (candidate.price_kind === "wholesale_candidate" &&
        !/(?:مستهلك|قطاعي|تجزئه|تجزئة|للمستهلك)/iu.test(candidate.raw_line || "") &&
        (hasExplicitWholesaleContext || hasMultiProductContext)) {
      candidate.price_kind = "wholesale";
      candidate.context_inferred_wholesale = true;
      candidate.price_selection_reason = [candidate.price_selection_reason, "message_level_wholesale_context"].filter(Boolean).join(";");
      // Context raises the classification quality, but does not by itself
      // approve a never-seen product identity.
      candidate.confidence = Math.max(candidate.confidence || 0, 0.68);
    }
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
    // Look up identity memory even when today's wording omits "جملة". The old
    // confidence gate made first observations pending (correctly), but also
    // prevented already-approved products from ever benefiting from memory.
    if (pool && !match.matched) {
      const known = await pool.query(
        "SELECT 1 FROM reviewed_price_products WHERE identity_key=$1 LIMIT 1",
        [identityKey(row)]
      );
      previouslyReviewed = known.rowCount > 0;
    }
    if (previouslyReviewed && candidate.price_kind === "wholesale_candidate") {
      row.price_kind = "wholesale";
      row.context_inferred_wholesale = true;
      row.price_selection_reason = [row.price_selection_reason, "previously_approved_product_identity"].filter(Boolean).join(";");
    }
    // Rows parsed from the two explicitly recognized, pre-interpreted catalog formats
    // have deterministic column semantics and are trusted as complete wholesale observations.
    // Ordinary chat messages still require registry/reviewer evidence as before.
    row.confidence = candidate.trusted_catalog_row
      ? candidate.confidence
      : previouslyReviewed
        ? Math.max(candidate.confidence, 0.9)
        : Math.min(candidate.confidence, match.matched ? 0.98 : 0.45);
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
      const previous = history.rows?.[0] || null;
      // If today's post omits carton count, reuse a known count from the same product/size history.
      // Keep the source wording intact and mark the count as inherited; never override an explicit count.
      if ((row.pack_count == null || row.pack_count === "") &&
          previous?.pack_count != null && Number(previous.pack_count) > 0) {
        row.pack_count = Number(previous.pack_count);
        row.pack_count_inferred = true;
        row.price_selection_reason = [row.price_selection_reason, "pack_count_inherited_from_prior_observation"].filter(Boolean).join(";");
        row.piece_sale_price = row.package_sale_price / row.pack_count;
      }
      row.change_type = classifyObservationChange(previous, row);
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
