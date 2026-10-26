"use strict";

const crypto = require("node:crypto");
const { normalizeArabic } = require("../core/normalization");

function identityKey(row) {
  const numberKey = value => value == null || value === "" ? "" : (Number.isFinite(Number(value)) ? String(Number(value)) : "");
  const parts = [normalizeArabic(row.product_text || ""), numberKey(row.weight_g), numberKey(row.volume_ml), numberKey(row.pack_count), row.brand_key || ""];
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
      `UPDATE price_observations SET decision=$1, reviewed_by=$2, reviewed_at=NOW(),
       review_reason=CASE WHEN $3='new' THEN 'new_product_approved' ELSE review_reason END
       WHERE id=$4 AND decision='pending'
       RETURNING id, product_text, weight_g, volume_ml, pack_count, brand_key, package_sale_price, price_kind`,
      [decision, reviewerId, action, id]
    );
    if (!result.rowCount) return { ok: false, reason: "already_resolved" };
    const row = result.rows[0];
    if (action === "new") {
      await client.query(
        `INSERT INTO reviewed_price_products(identity_key, product_text, weight_g, volume_ml, pack_count, brand_key, approved_by)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(identity_key) DO UPDATE SET approved_by=EXCLUDED.approved_by, approved_at=NOW()`,
        [identityKey(row), row.product_text, row.weight_g, row.volume_ml, row.pack_count, row.brand_key, reviewerId]
      );
    }
    await client.query(
      "UPDATE price_review_queue SET status=$1, reviewed_by=$2, reviewed_at=NOW() WHERE observation_id=$3 AND status='pending'",
      [decision, reviewerId, id]
    );
    return { ok: true, decision, row };
  });
}

async function saveEditedReview({ db, id, reviewerId, productText, price, weightG = null, volumeMl = null, packCount = null }) {
  return db.withTransaction(async client => {
    const result = await client.query(
      `UPDATE price_observations SET product_text=$1, package_sale_price=$2, price_kind='wholesale',
       weight_g=$3, volume_ml=$4, pack_count=$5, confidence=1, decision='accepted',
       reviewed_by=$6, reviewed_at=NOW(), review_reason='manually_corrected'
       WHERE id=$7 AND decision='pending' RETURNING id`,
      [productText, price, weightG, volumeMl, packCount, reviewerId, id]
    );
    if (!result.rowCount) return { ok: false, reason: "already_resolved" };
    await client.query(
      "UPDATE price_review_queue SET status='accepted', reviewed_by=$1, reviewed_at=NOW() WHERE observation_id=$2 AND status='pending'",
      [reviewerId, id]
    );
    return { ok: true };
  });
}
module.exports = { identityKey, formatReviewMessage, reviewKeyboard, resolveReview, saveEditedReview };
