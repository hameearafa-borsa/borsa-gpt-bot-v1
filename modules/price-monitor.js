"use strict";

const { extractPriceCandidates, commercialMetrics, fingerprint } = require("./price-intelligence");
const { resolve } = require("../core/product-registry");
const { identityKey } = require("./price-review");

function isOwnMessage({ botUserId, fromId }) { return botUserId != null && String(botUserId) === String(fromId); }
function isEligibleMessage({ chatType, text, isLogChannel, isCommand, ownMessage }) {
  return ["group", "supergroup"].includes(chatType) && !isLogChannel && !isCommand && !ownMessage && Boolean(String(text || "").trim());
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
    const inserted = await pool.query(
      `INSERT INTO price_observations
       (merchant_id,price_kind,package_sale_price,source_chat_id,source_message_id,source_user_id,raw_text,confidence,
        product_text,weight_g,volume_ml,pack_count,offer_extra_weight_g,decision,brand_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [merchantId, row.price_kind, row.package_sale_price, message.chatId || null, message.messageId || null,
       message.userId || null, row.raw_line, row.confidence, row.product_text, row.weight_g, row.volume_ml,
       row.pack_count, row.offer_extra_weight_g, row.decision, row.brand_key]
    );
    savedRows.push({ id: inserted.rows[0].id, row });
  }
  return { accepted, saved: savedRows.length, savedRows, silent: true };
}

module.exports = { isOwnMessage, isEligibleMessage, observe };
