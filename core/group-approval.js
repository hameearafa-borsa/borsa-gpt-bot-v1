"use strict";

/**
 * Atomically activate a group and mark its pending approval as approved.
 * Telegram creator verification and fixed-master authorization must happen
 * before calling this function. A transaction prevents an active group from
 * being left behind if the approval record update fails.
 */
async function approvePendingGroup({ db, chatId, chatType, ownerUserId, approvedBy }) {
  if (!db || typeof db.withTransaction !== "function") {
    throw new TypeError("approvePendingGroup requires db.withTransaction(fn)");
  }
  return db.withTransaction(async client => {
    const pending = await client.query(
      "SELECT status FROM pending_group_approvals WHERE chat_id=$1 FOR UPDATE",
      [chatId]
    );
    if (pending.rows?.[0]?.status !== "pending") {
      throw new Error("GROUP_APPROVAL_NOT_PENDING");
    }

    await client.query(
      `INSERT INTO authorized_chats(chat_id,chat_type,owner_user_id,authorized_by)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(chat_id) DO UPDATE SET
         chat_type=EXCLUDED.chat_type,
         owner_user_id=EXCLUDED.owner_user_id,
         authorized_by=EXCLUDED.authorized_by,
         active=TRUE`,
      [chatId, chatType, ownerUserId, approvedBy]
    );

    const updated = await client.query(
      `UPDATE pending_group_approvals
       SET status='approved', approved_by=$2, approved_at=NOW(), owner_user_id=$3
       WHERE chat_id=$1 AND status='pending'`,
      [chatId, approvedBy, ownerUserId]
    );
    if (updated.rowCount !== 1) throw new Error("GROUP_APPROVAL_STATE_CHANGED");
    return { chatId, ownerUserId, approvedBy };
  });
}

module.exports = { approvePendingGroup };
