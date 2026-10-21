"use strict";

const { extractPriceCandidates, commercialMetrics, fingerprint } = require("./price-intelligence");
const { resolve } = require("../core/product-registry");
const { normalizeArabic } = require("../core/normalization");

function isOwnMessage({ botUserId, fromId }) { return botUserId != null && String(botUserId) === String(fromId); }
function isEligibleMessage({ chatType, text, isLogChannel, isCommand, ownMessage }) {
  return ["group", "supergroup"].includes(chatType) && !isLogChannel && !isCommand && !ownMessage && Boolean(String(text || "").trim());
}

async function observe({ pool, message, merchantId = null, registry }) {
  const text = message.text || message.caption || "";
  const candidates = extractPriceCandidates(text);
  const accepted = [];
  const seen = new Set();
  for (const c of candidates) {
    if (c.price_kind === "retail") continue;
    const match = resolve(c.product_text, registry);
    // Unknown product names are retained only as review candidates, never as high-confidence facts.
    const row = { ...c, ...commercialMetrics(c), merchant_id: merchantId, registry_match: match.matched, registry_confidence: match.confidence };
    row.confidence = Math.min(c.confidence, match.matched ? 0.98 : 0.45);
    const fp = fingerprint(row);
    if (seen.has(fp)) continue;
    seen.add(fp);
    accepted.push(row);
  }

  const savedRows = [];
  if (!pool) return { accepted, saved: 0, savedRows, silent: true };
  for (const row of accepted) {
    if (row.confidence < 0.8) continue;
    const duplicate = await pool.query(
      `SELECT 1 FROM price_observations WHERE source_chat_id=$1 AND source_message_id=$2 AND raw_text=$3 LIMIT 1`,
      [message.chatId || null, message.messageId || null, row.raw_line]
    );
    if (duplicate.rowCount) continue;
    const inserted = await pool.query(
      `INSERT INTO price_observations (merchant_id,price_kind,package_sale_price,source_chat_id,source_message_id,source_user_id,raw_text,confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [merchantId, row.price_kind, row.package_sale_price, message.chatId || null, message.messageId || null, message.userId || null, row.raw_line, row.confidence]
    );
    savedRows.push({ id: inserted.rows[0].id, row });
  }
  return { accepted, saved: savedRows.length, savedRows, silent: true };
}

module.exports = { isOwnMessage, isEligibleMessage, observe };
