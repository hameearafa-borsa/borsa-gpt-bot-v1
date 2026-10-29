"use strict";

const crypto = require("node:crypto");
const { normalizeArabic } = require("../core/normalization");
const { productIdentityKey } = require("./price-intelligence");
const { resolve } = require("../core/product-registry");

function identityKey(row) {
  const numberKey = value => value == null || value === "" ? "" : (Number.isFinite(Number(value)) ? String(Number(value)) : "");
  // Reviewer memory follows the product and size, not a temporary carton count that may change in promotions.
  const productName = String(row.product_text || "").split(/\s+[—–-]\s+(?=(?:عرض|العرض|شراء))/u)[0];
  const parts = [normalizeArabic(productName), numberKey(row.weight_g), numberKey(row.volume_ml), row.brand_key || ""];
  // Carton count may change across promotions, but package form and free-extra
  // weight define distinct product offers and must not share reviewer memory.
  const hasExtraWeight = row.offer_extra_weight_g != null && row.offer_extra_weight_g !== "";
  const packageType = String(row.package_type || "").trim();
  if (hasExtraWeight || packageType) parts.push(numberKey(row.offer_extra_weight_g), packageType);
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

function formatReviewMessage(id, row) {
  const name = String(row.product_text || "صنف غير محدد").replace(/\s+/g, " ").slice(0, 100);
  const raw = String(row.raw_line || "").replace(/\s+/g, " ").slice(0, 500);
  const price = Number(row.package_sale_price);
  const priceText = Number.isFinite(price) ? `${price.toFixed(2)} ج.م` : "غير واضح";
  const quantity = [row.weight_g ? `${row.weight_g} جم` : null, row.volume_ml ? `${row.volume_ml} مل` : null, row.pack_count ? `عدد العبوات ${row.pack_count}` : null].filter(Boolean).join(" / ") || "غير محدد";
  return `🔎 مراجعة سعر معلّق #${id}\n\nالصنف: ${name}\nالسعر المرصود: ${priceText}\nنوع السعر: ${row.price_kind || "غير محدد"}\nالعبوة: ${quantity}\n\nالنص الأصلي: ${raw}\n\nاختر إجراءً واحدًا. لا يُعدّل البوت رسالة المصدر الأصلية.`;
}

function reviewKeyboard(id) {
  return { inline_keyboard: [
    [{ text: "✅ اعتماد السعر", callback_data: `prv:approve:${id}` }, { text: "🆕 اعتماد كصنف جديد", callback_data: `prv:new:${id}` }],
    [{ text: "✏️ تعديل في الخاص", callback_data: `prv:edit:${id}` }, { text: "🚫 تجاهل", callback_data: `prv:ignore:${id}` }]
  ] };
}

async function resolveReview({ db, id, action, reviewerId }) {
  const decision = action === "ignore" ? "ignored" : "accepted";
  return db.withTransaction(async client => {
    const result = await client.query(
      `UPDATE price_observations SET decision=$1, reviewed_by=$2, reviewed_at=NOW(), needs_review=FALSE,
       review_reason=CASE WHEN $3='new' THEN 'new_product_approved' ELSE review_reason END
       WHERE id=$4 AND decision='pending'
       RETURNING id, product_text, weight_g, volume_ml, pack_count, brand_key, offer_extra_weight_g, package_type, package_sale_price, price_kind`,
      [decision, reviewerId, action, id]
    );
    if (!result.rowCount) return { ok: false, reason: "already_resolved" };
    const row = result.rows[0];
    if (action === "new") {
      await client.query(
        `INSERT INTO reviewed_price_products(identity_key, product_text, weight_g, volume_ml, pack_count, brand_key, approved_by, offer_extra_weight_g, package_type)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(identity_key) DO UPDATE SET approved_by=EXCLUDED.approved_by, approved_at=NOW(),
           offer_extra_weight_g=EXCLUDED.offer_extra_weight_g, package_type=EXCLUDED.package_type`,
        [identityKey(row), row.product_text, row.weight_g, row.volume_ml, row.pack_count, row.brand_key, reviewerId, row.offer_extra_weight_g ?? null, row.package_type ?? null]
      );
    }
    const queued = await client.query(
      "UPDATE price_review_queue SET status=$1, reviewed_by=$2, reviewed_at=NOW(), notification_claim_token=NULL, notification_claimed_at=NULL WHERE observation_id=$3 AND status='pending' RETURNING id",
      [decision, reviewerId, id]
    );
    // If the queue row is missing or already resolved, throw so the transaction
    // rolls back the observation decision (and any new-product identity insert).
    if (!queued.rowCount) throw new Error("price_review_queue_missing_or_resolved");
    return { ok: true, decision, row };
  });
}

async function saveEditedReview({ db, id, reviewerId, productText, price, weightG = null, volumeMl = null, packCount = null }) {
  const productMatch = resolve(productText);
  const brandKey = productMatch.matched ? productMatch.brand?.key || null : null;
  return db.withTransaction(async client => {
    const result = await client.query(
      `UPDATE price_observations SET product_text=$1, package_sale_price=$2, price_kind='wholesale',
       weight_g=$3, volume_ml=$4, pack_count=$5, brand_key=$6, confidence=1, decision='accepted',
       explicit_wholesale_label_price=$2, reviewed_by=$7, reviewed_at=NOW(), review_reason='manually_corrected',
       price_selection_reason='manually_corrected', needs_review=FALSE
       WHERE id=$8 AND decision='pending'
       RETURNING id, product_text, weight_g, volume_ml, pack_count, brand_key, package_type, offer_extra_weight_g, price_kind`,
      [productText, price, weightG, volumeMl, packCount, brandKey, reviewerId, id]
    );
    if (!result.rowCount) return { ok: false, reason: "already_resolved" };
    // Rebuild the canonical history identity from the corrected fields. Otherwise
    // future prices could be attached to the pre-edit product/weight identity.
    const row = {
      ...result.rows[0], product_text: productText, package_sale_price: price,
      price_kind: "wholesale", weight_g: weightG, volume_ml: volumeMl, pack_count: packCount,
      brand_key: brandKey
    };
    const productKey = productIdentityKey(row);
    await client.query(
      "UPDATE price_observations SET product_identity_key=$1 WHERE id=$2",
      [productKey, id]
    );
    // A human-reviewed correction is an approval decision too: remember the
    // corrected identity so future clear observations do not trigger review again.
    await client.query(
      `INSERT INTO reviewed_price_products(identity_key, product_text, weight_g, volume_ml, pack_count, brand_key, approved_by, offer_extra_weight_g, package_type)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(identity_key) DO UPDATE SET approved_by=EXCLUDED.approved_by, approved_at=NOW(),
         offer_extra_weight_g=EXCLUDED.offer_extra_weight_g, package_type=EXCLUDED.package_type`,
      [identityKey(row), productText, weightG, volumeMl, packCount, row.brand_key || null, reviewerId, row.offer_extra_weight_g ?? null, row.package_type ?? null]
    );
    const queued = await client.query(
      "UPDATE price_review_queue SET status='accepted', reviewed_by=$1, reviewed_at=NOW(), notification_claim_token=NULL, notification_claimed_at=NULL WHERE observation_id=$2 AND status='pending' RETURNING id",
      [reviewerId, id]
    );
    if (!queued.rowCount) throw new Error("price_review_queue_missing_or_resolved");
    return { ok: true, product_identity_key: productKey };
  });
}

function formatPriceEditPrompt(id, row = null) {
  const clean = value => {
    if (value == null || value === "") return "-";
    return String(value).replace(/[|]/g, " ").trim() || "-";
  };
  const fallback = ["اسم الصنف", "السعر", "الوزن_بالجرام أو -", "الحجم_بالمللي أو -", "عدد العبوات أو -"];
  const fields = row
    ? [
        clean(row.product_text),
        row.package_sale_price == null ? "السعر" : Number(row.package_sale_price).toFixed(2),
        clean(row.weight_g),
        clean(row.volume_ml),
        clean(row.pack_count)
      ]
    : fallback;
  return `✏️ تعديل سجل السعر #${id}\n\nعدّل القيم التي تحتاج تغييرها فقط، واترك باقي القيم كما هي. انسخ الأمر التالي في الخاص، مع الفصل بعلامة | :\n/priceedit ${id} | ${fields.join(" | ")}\n\nاستخدم - إذا كانت قيمة الوزن أو الحجم أو عدد العبوات غير معروفة. سيُحفظ السعر المعدل كسعر جملة معتمد؛ لا تعتمد السعر إلا إذا تأكدت أنه سعر جملة.`;
}

module.exports = { identityKey, formatReviewMessage, formatPriceEditPrompt, reviewKeyboard, resolveReview, saveEditedReview };
