"use strict";

const { formatReviewMessage, reviewKeyboard } = require("./price-review");

async function recoverPendingNotifications({
  db,
  telegram,
  defaultLogChatId = null,
  onError = async () => {},
  limit = 100,
}) {
  if (!db || typeof db.query !== "function") throw new TypeError("db.query is required");
  if (!telegram || typeof telegram.sendMessage !== "function") throw new TypeError("telegram.sendMessage is required");
  const batchSize = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 100));
  const result = await db.query(
    `SELECT q.observation_id, COALESCE(q.log_chat_id, $1) AS target_log_chat_id,
            po.product_text, po.weight_g, po.volume_ml, po.pack_count, po.brand_key,
            po.raw_text AS raw_line, po.package_sale_price, po.price_kind
       FROM price_review_queue q
       JOIN price_observations po ON po.id = q.observation_id
      WHERE q.status = 'pending' AND q.log_message_id IS NULL
      ORDER BY q.created_at ASC, q.id ASC
      LIMIT $2`,
    [defaultLogChatId, batchSize]
  );

  const stats = { found: result.rows.length, sent: 0, failed: 0 };
  for (const row of result.rows) {
    let sentMessage = null;
    try {
      if (row.target_log_chat_id == null || row.target_log_chat_id === "") {
        throw new Error("price_review_log_chat_missing");
      }
      sentMessage = await telegram.sendMessage(
        row.target_log_chat_id,
        formatReviewMessage(row.observation_id, row),
        { reply_markup: reviewKeyboard(row.observation_id), disable_web_page_preview: true }
      );
      const saved = await db.query(
        `UPDATE price_review_queue SET log_message_id = $1
          WHERE observation_id = $2 AND status = 'pending' AND log_message_id IS NULL
          RETURNING observation_id`,
        [sentMessage.message_id, row.observation_id]
      );
      if (!saved.rowCount) {
        await telegram.deleteMessage?.(row.target_log_chat_id, sentMessage.message_id).catch(() => {});
        throw new Error("price_review_notification_claim_lost");
      }
      stats.sent += 1;
    } catch (error) {
      stats.failed += 1;
      // If Telegram accepted the message but persistence failed, best-effort cleanup
      // avoids leaving a second actionable review message for the same queue row.
      if (sentMessage?.message_id != null && row.target_log_chat_id != null) {
        try { await telegram.deleteMessage?.(row.target_log_chat_id, sentMessage.message_id); } catch {}
      }
      try {
        await onError(error, { observationId: row.observation_id, logChatId: row.target_log_chat_id ?? null });
      } catch {}
    }
  }
  return stats;
}

module.exports = { recoverPendingNotifications };
