"use strict";

async function recordActivity(pool, { chatId, userId, username, displayName }) {
  if (!pool || !chatId || !userId) return false;
  await pool.query(`INSERT INTO member_activity(chat_id,user_id,username,display_name)
    VALUES($1,$2,$3,$4) ON CONFLICT(chat_id,user_id) DO UPDATE SET
    username=COALESCE(EXCLUDED.username,member_activity.username),
    display_name=COALESCE(EXCLUDED.display_name,member_activity.display_name),
    last_seen_at=NOW(),message_count=member_activity.message_count+1`,
    [chatId,userId,username || null,displayName || null]);
  return true;
}
async function addWarning(pool, { chatId, userId, issuedBy, reason }) {
  if (!pool) throw new Error("DATABASE_URL غير مضبوط");
  if (!Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(userId)) || !Number.isSafeInteger(Number(issuedBy))) throw new Error("معرّف المجموعة أو العضو أو المشرف غير صالح");
  const cleanReason = String(reason || "مخالفة قواعد المجموعة").trim().slice(0,500);
  const inserted = await pool.query(`INSERT INTO member_warnings(chat_id,user_id,issued_by,reason) VALUES($1,$2,$3,$4) RETURNING id,created_at`, [chatId,userId,issuedBy,cleanReason]);
  const count = await pool.query("SELECT COUNT(*)::int AS count FROM member_warnings WHERE chat_id=$1 AND user_id=$2 AND active=TRUE", [chatId,userId]);
  return { id: inserted.rows[0].id, count: count.rows[0].count, reason: cleanReason };
}
async function listWarnings(pool, chatId, userId) {
  const r = await pool.query(`SELECT id,reason,issued_by,created_at FROM member_warnings WHERE chat_id=$1 AND user_id=$2 AND active=TRUE ORDER BY created_at DESC LIMIT 20`, [chatId,userId]);
  return r.rows;
}
async function clearWarnings(pool, { chatId, userId, clearedBy }) {
  const r = await pool.query(`UPDATE member_warnings SET active=FALSE,cleared_at=NOW(),cleared_by=$3 WHERE chat_id=$1 AND user_id=$2 AND active=TRUE`, [chatId,userId,clearedBy]);
  return r.rowCount;
}
async function listInactive(pool, chatId, days = 30, limit = 20) {
  const d = Math.max(1,Math.min(365,Number(days)||30));
  const n = Math.max(1,Math.min(50,Number(limit)||20));
  const r = await pool.query(`SELECT user_id,username,display_name,last_seen_at,message_count,
      FLOOR(EXTRACT(EPOCH FROM (NOW()-last_seen_at))/86400)::int AS inactive_days
    FROM member_activity WHERE chat_id=$1 AND last_seen_at < NOW() - ($2::text || ' days')::interval
    ORDER BY last_seen_at ASC LIMIT $3`, [chatId,String(d),n]);
  return r.rows;
}
module.exports = { recordActivity, addWarning, listWarnings, clearWarnings, listInactive };
