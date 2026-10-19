"use strict";

const { extractPriceCandidates, commercialMetrics } = require("./price-intelligence");
const { resolve } = require("../core/product-registry");
const { normalizeArabic } = require("../core/normalization");

function isOwnMessage({ botUserId, fromId }) { return botUserId != null && String(botUserId) === String(fromId); }
function isEligibleMessage({ chatType, text, isLogChannel, isCommand, ownMessage }) {
  return ["group", "supergroup"].includes(chatType) && !isLogChannel && !isCommand && !ownMessage && Boolean(String(text || "").trim());
}

async function ensureCatalog(pool, row, match) {
  if (!pool || !match?.matched || !match.brand) return { productId: null, variantId: null };
  const name = match.family?.name_ar || match.brand.name_ar;
  const normalized = normalizeArabic(name);
  if (!name || !normalized) return { productId: null, variantId: null };
  const product = await pool.query(
    `INSERT INTO products(name_ar, normalized_name, category)
     VALUES($1,$2,'detergent')
     ON CONFLICT (normalized_name) DO UPDATE SET active=TRUE
     RETURNING id`,
    [name, normalized]
  );
  const productId = product.rows[0]?.id || null;
  if (!productId) return { productId: null, variantId: null };
  const weight = row.weight_g ?? null;
  const pack = row.pack_count ?? null;
  const extra = row.offer_extra_weight_g ?? null;
  if (weight == null && pack == null && extra == null) return { productId, variantId: null };
  const found = await pool.query(
    `SELECT id FROM product_variants
     WHERE product_id=$1 AND weight_g IS NOT DISTINCT FROM $2 AND pack_count IS NOT DISTINCT FROM $3 AND offer_extra_weight_g IS NOT DISTINCT FROM $4
     LIMIT 1`,
    [productId, weight, pack, extra]
  );
  if (found.rows[0]?.id) return { productId, variantId: found.rows[0].id };
  const inserted = await pool.query(
    `INSERT INTO product_variants(product_id, weight_g, pack_count, offer_extra_weight_g) VALUES($1,$2,$3,$4) RETURNING id`,
    [productId, weight, pack, extra]
  );
  return { productId, variantId: inserted.rows[0]?.id || null };
}

async function insertObservation(pool, row) {
  const full = [
    row.productId, row.variantId, row.merchant_id, row.price_kind, row.package_sale_price,
    row.chatId, row.messageId, row.userId, row.raw_line, row.confidence,
    row.product_text, row.weight_g, row.volume_ml, row.pack_count, row.offer_extra_weight_g, row.decision, row.brand_key,
  ];
  try {
    return await pool.query(
      `INSERT INTO price_observations (
         product_id, variant_id, merchant_id, price_kind, package_sale_price,
         source_chat_id, source_message_id, source_user_id, raw_text, confidence,
         product_text, weight_g, volume_ml, pack_count, offer_extra_weight_g, decision, brand_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      full
    );
  } catch (err) {
    if (err.code !== "42703") throw err;
    return pool.query(
      `INSERT INTO price_observations (merchant_id,price_kind,package_sale_price,source_chat_id,source_message_id,source_user_id,raw_text,confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [row.merchant_id, row.price_kind, row.package_sale_price, row.chatId, row.messageId, row.userId, row.raw_line, row.confidence]
    );
  }
}

async function observe({ pool, message, merchantId = null, registry }) {
  const text = message.text || message.caption || "";
  const candidates = extractPriceCandidates(text);
  const accepted = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (candidate.price_kind === "retail") continue;
    const match = resolve(candidate.product_text, registry);
    const metrics = commercialMetrics(candidate);
    const label = normalizeArabic(candidate.product_text);
    const brandMatched = Boolean(match.matched && match.brand);
    let decision = null;
    if (brandMatched && candidate.package_sale_price > 0 && label.length >= 2) decision = "accepted";
    else if (label.length >= 3 && candidate.package_sale_price > 0 && !/^\d/.test(label)) decision = "review";
    if (!decision) continue;
    const confidence = decision === "accepted"
      ? Math.max(0.86, Math.min(0.98, Number(candidate.confidence) || 0))
      : Math.min(Number(candidate.confidence) || 0.45, 0.6);
    const row = {
      ...candidate,
      ...metrics,
      merchant_id: merchantId,
      registry_match: match.matched,
      registry_confidence: match.confidence,
      confidence,
      decision,
      brand_key: match.brand?.key || null,
    };
    const fp = `${decision}|${row.brand_key || label}|${row.weight_g || ""}|${row.package_sale_price}|${row.pack_count || ""}`;
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
    let productId = null;
    let variantId = null;
    if (row.decision === "accepted") {
      try {
        const catalog = await ensureCatalog(pool, row, resolve(row.product_text, registry));
        productId = catalog.productId;
        variantId = catalog.variantId;
      } catch (err) {
        if (err.code !== "42P01" && err.code !== "42703") throw err;
      }
    }
    const inserted = await insertObservation(pool, {
      ...row,
      productId,
      variantId,
      chatId: message.chatId || null,
      messageId: message.messageId || null,
      userId: message.userId || null,
    });
    savedRows.push({ id: inserted.rows[0].id, row });
  }
  return { accepted, saved: savedRows.length, savedRows, silent: true };
}

module.exports = { isOwnMessage, isEligibleMessage, observe };
