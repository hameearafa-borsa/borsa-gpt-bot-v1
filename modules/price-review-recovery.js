"use strict";
const crypto = require("node:crypto");
const { formatReviewMessage, reviewKeyboard } = require("./price-review");
const CLAIM_LEASE_SECONDS = 120;

async function recoverPendingNotifications({ db, telegram, defaultLogChatId = null, onError = async () => {}, limit = 100 }) {
  if (!db || typeof db.query !== "function") throw new TypeError("db.query is required");
  if (!telegram || typeof telegram.sendMessage !== "function") throw new TypeError("telegram.sendMessage is required");
  const batchSize = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 100));
  try {
    await db.query(
      `INSERT INTO price_review_queue (observation_id, source_chat_id, log_chat_id)
       SELECT po.id, po.source_chat_id, $1 FROM price_observations po
       LEFT JOIN price_review_queue q ON q.observation_id = po.id
       WHERE po.decision = 'pending' AND q.observation_id IS NULL
       ON CONFLICT (observation_id) DO NOTHING`, [defaultLogChatId]);
  } catch (error) {
    try { await onError(error, { stage: "rebuild_missing_queue", observationId: null, logChatId: defaultLogChatId }); } catch {}
  }
  const token = crypto.randomUUID();
  const result = await db.query(
    `WITH candidates AS (
       SELECT q.observation_id FROM price_review_queue q
       WHERE q.status = 'pending' AND q.log_message_id IS NULL
         AND (q.notification_claimed_at IS NULL OR q.notification_claimed_at < NOW() - ($3 * INTERVAL '1 second'))
       ORDER BY q.created_at ASC, q.id ASC LIMIT $2 FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE price_review_queue q SET notification_claim_token = $4, notification_claimed_at = NOW()
       FROM candidates c WHERE q.observation_id = c.observation_id
       RETURNING q.observation_id, q.log_chat_id
     )
     SELECT c.observation_id, COALESCE(c.log_chat_id, $1) AS target_log_chat_id,
            po.product_text, po.weight_g, po.volume_ml, po.pack_count, po.brand_key,
            po.raw_text AS raw_line, po.package_sale_price, po.price_kind
       FROM claimed c JOIN price_observations po ON po.id = c.observation_id
       ORDER BY c.observation_id ASC`,
    [defaultLogChatId, batchSize, CLAIM_LEASE_SECONDS, token]);
  const stats = { found: result.rows.length, sent: 0, failed: 0 };
  for (const row of result.rows) {
    let sentMessage = null;
    try {
      if (row.target_log_chat_id == null || row.target_log_chat_id === "") throw new Error("price_review_log_chat_missing");
      sentMessage = await telegram.sendMessage(row.target_log_chat_id, formatReviewMessage(row.observation_id, row), {
        reply_markup: reviewKeyboard(row.observation_id), disable_web_page_preview: true
      });
      const saved = await db.query(
        `UPDATE price_review_queue SET log_message_id = $1, notification_claim_token = NULL, notification_claimed_at = NULL
         WHERE observation_id = $2 AND status = 'pending' AND log_message_id IS NULL AND notification_claim_token = $3
         RETURNING observation_id`,
        [sentMessage.message_id, row.observation_id, token]);
      if (!saved.rowCount) throw new Error("price_review_notification_claim_lost");
      stats.sent += 1;
    } catch (error) {
      stats.failed += 1;
      if (sentMessage?.message_id != null && row.target_log_chat_id != null) {
        try { await telegram.deleteMessage?.(row.target_log_chat_id, sentMessage.message_id); } catch {}
      }
      try { await onError(error, { observationId: row.observation_id, logChatId: row.target_log_chat_id ?? null }); } catch {}
    }
  }
  return stats;
}
module.exports = { CLAIM_LEASE_SECONDS, recoverPendingNotifications };
