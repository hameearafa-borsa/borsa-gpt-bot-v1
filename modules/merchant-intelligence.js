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

  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  const transactional = typeof pool.connect === "function";
  try {
    if (transactional) {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [phone]);
    }

    const found = await client.query("SELECT * FROM merchants WHERE phone = $1 FOR UPDATE", [phone]);
    if (found.rows[0]) {
      const old = found.rows[0];
      const changed = ["name", "activity", "location", "telegram_username"]
        .some((key) => String(old[key] || "") !== String(clean[key] || ""));

      // Keep provenance for each distinct Telegram source message, even when the
      // merchant profile itself is unchanged. The partial unique index makes webhook
      // retries idempotent without suppressing different messages from the same seller.
      const src = await client.query(
        `INSERT INTO merchant_sources (merchant_id, source_chat_id, source_message_id, source_user_id, raw_text)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (source_chat_id, source_message_id)
         WHERE source_chat_id IS NOT NULL AND source_message_id IS NOT NULL
         DO NOTHING RETURNING id`,
        [old.id, source.chatId ?? null, source.messageId ?? null, source.userId ?? null, source.rawText || null]
      );

      if (!changed) {
        if (transactional) await client.query("COMMIT");
        return { saved: false, updated: false, sourceRecorded: Boolean(src.rows[0]), merchant: old };
      }

      const sourceId = src.rows[0]?.id ?? null;
      await client.query(
        "UPDATE merchant_history SET valid_to=NOW() WHERE merchant_id=$1 AND valid_to IS NULL",
        [old.id]
      );
      const updated = await client.query(
        `UPDATE merchants SET name=$1, activity=$2, location=$3,
         telegram_username=COALESCE($4,telegram_username), updated_at=NOW() WHERE id=$5 RETURNING *`,
        [clean.name, clean.activity, clean.location, clean.telegram_username, old.id]
      );
      await client.query(
        `INSERT INTO merchant_history (merchant_id,name,activity,location,phone,telegram_username,source_id,valid_from,valid_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NULL)`,
        [old.id, clean.name, clean.activity, clean.location, clean.phone,
          clean.telegram_username ?? old.telegram_username, sourceId]
      );
      if (transactional) await client.query("COMMIT");
      return { saved: true, updated: true, sourceRecorded: Boolean(sourceId), merchant: updated.rows[0] };
    }

    const inserted = await client.query(
      `INSERT INTO merchants (name,activity,location,phone,telegram_username)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [clean.name, clean.activity, clean.location, clean.phone, clean.telegram_username]
    );
    const savedMerchant = inserted.rows[0];
    const src = await client.query(
      `INSERT INTO merchant_sources (merchant_id,source_chat_id,source_message_id,source_user_id,raw_text)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (source_chat_id, source_message_id)
       WHERE source_chat_id IS NOT NULL AND source_message_id IS NOT NULL
       DO NOTHING RETURNING id`,
      [savedMerchant.id, source.chatId ?? null, source.messageId ?? null, source.userId ?? null, source.rawText || null]
    );
    await client.query(
      `INSERT INTO merchant_history (merchant_id,name,activity,location,phone,telegram_username,source_id,valid_from,valid_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NULL)`,
      [savedMerchant.id, clean.name, clean.activity, clean.location, clean.phone, clean.telegram_username, src.rows[0]?.id ?? null]
    );
    if (transactional) await client.query("COMMIT");
    return { saved: true, updated: false, sourceRecorded: Boolean(src.rows[0]), merchant: savedMerchant };
  } catch (error) {
    if (transactional) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

function merchantKey(merchant) {
  return normalizePhone(merchant.phone) || normalizeArabic(merchant.name);
}

module.exports = { saveMerchant, merchantKey };
