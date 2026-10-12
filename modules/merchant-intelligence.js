"use strict";

const { normalizePhone, normalizeArabic } = require("../core/normalization");

async function saveMerchant(pool, merchant, source = {}) {
  if (!pool) throw new Error("DATABASE_URL غير مضبوط");
  const phone = normalizePhone(merchant.phone);
  if (!phone) return { saved: false, reason: "invalid_phone" };
  const clean = {
    name: String(merchant.name || "").trim() || "غير محدد",
    activity: String(merchant.activity || "").trim() || "غير محدد",
    location: String(merchant.location || "").trim() || "غير محدد",
    phone,
    telegram_username: String(merchant.telegram_username || "").replace(/^@/, "").trim() || null,
  };

  return pool.query("SELECT * FROM merchants WHERE phone = $1", [phone]).then(async (found) => {
    if (found.rows[0]) {
      const old = found.rows[0];
      const changed = ["name", "activity", "location", "telegram_username"].some((k) => String(old[k] || "") !== String(clean[k] || ""));
      if (!changed) return { saved: false, updated: false, merchant: old };
      const src = await pool.query(
        `INSERT INTO merchant_sources (merchant_id, source_chat_id, source_message_id, source_user_id, raw_text)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [old.id, source.chatId || null, source.messageId || null, source.userId || null, source.rawText || null]
      );
      await pool.query(
        `INSERT INTO merchant_history (merchant_id,name,activity,location,phone,telegram_username,source_id,valid_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [old.id, old.name, old.activity, old.location, old.phone, old.telegram_username, src.rows[0].id]
      );
      const updated = await pool.query(
        `UPDATE merchants SET name=$1, activity=$2, location=$3,
         telegram_username=COALESCE($4,telegram_username), updated_at=NOW() WHERE id=$5 RETURNING *`,
        [clean.name, clean.activity, clean.location, clean.telegram_username, old.id]
      );
      return { saved: true, updated: true, merchant: updated.rows[0] };
    }

    const inserted = await pool.query(
      `INSERT INTO merchants (name,activity,location,phone,telegram_username)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [clean.name, clean.activity, clean.location, clean.phone, clean.telegram_username]
    );
    const m = inserted.rows[0];
    await pool.query(
      `INSERT INTO merchant_sources (merchant_id,source_chat_id,source_message_id,source_user_id,raw_text)
       VALUES ($1,$2,$3,$4,$5)`,
      [m.id, source.chatId || null, source.messageId || null, source.userId || null, source.rawText || null]
    );
    return { saved: true, updated: false, merchant: m };
  });
}

function merchantKey(merchant) {
  return normalizePhone(merchant.phone) || normalizeArabic(merchant.name);
}

module.exports = { saveMerchant, merchantKey };
