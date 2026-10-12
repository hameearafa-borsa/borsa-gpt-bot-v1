"use strict";

const MAX_BATCH = 25;

async function ensureSchedulerSchema(pool) {
  if (!pool) throw new Error("scheduler requires PostgreSQL");
  await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_messages (
    id BIGSERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, message_text TEXT NOT NULL,
    schedule_kind TEXT NOT NULL DEFAULT 'once' CHECK (schedule_kind IN ('once','daily')),
    run_at TIMESTAMPTZ NOT NULL, timezone TEXT NOT NULL DEFAULT 'Africa/Cairo',
    enabled BOOLEAN NOT NULL DEFAULT TRUE, last_sent_at TIMESTAMPTZ,
    created_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(enabled,run_at)`);
}

async function createScheduledMessage(pool, row) {
  if (!pool) throw new Error("DATABASE_URL غير مضبوط");
  const text = String(row.message_text || "").trim();
  const chatId = Number(row.chat_id);
  const runAt = new Date(row.run_at);
  const kind = row.schedule_kind === "daily" ? "daily" : "once";
  if (!text || text.length > 3500) throw new Error("نص الرسالة مطلوب وبحد أقصى 3500 حرف");
  if (!Number.isSafeInteger(chatId)) throw new Error("chat_id غير صالح");
  if (Number.isNaN(runAt.getTime()) || runAt.getTime() < Date.now() + 30_000) throw new Error("موعد الرسالة يجب أن يكون بعد 30 ثانية على الأقل");
  const r = await pool.query(`INSERT INTO scheduled_messages(chat_id,message_text,schedule_kind,run_at,timezone,created_by)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id,chat_id,schedule_kind,run_at,timezone,enabled`,
    [chatId,text,kind,runAt.toISOString(),row.timezone || "Africa/Cairo",row.created_by || null]);
  return r.rows[0];
}

async function listScheduledMessages(pool, chatId) {
  const r = await pool.query(`SELECT id,chat_id,message_text,schedule_kind,run_at,timezone,enabled,last_sent_at
    FROM scheduled_messages WHERE chat_id=$1 ORDER BY run_at LIMIT $2`, [chatId, MAX_BATCH]);
  return r.rows;
}

async function dispatchDue(pool, telegram, { onError = () => {} } = {}) {
  if (!pool || !telegram) return { checked: 0, sent: 0, failed: 0 };
  const due = await pool.query(`SELECT * FROM scheduled_messages WHERE enabled=TRUE AND run_at <= NOW() ORDER BY run_at LIMIT $1`, [MAX_BATCH]);
  let sent = 0, failed = 0;
  for (const job of due.rows) {
    try {
      await telegram.sendMessage(job.chat_id, job.message_text, { disable_web_page_preview: true });
      if (job.schedule_kind === "daily") {
        await pool.query(`UPDATE scheduled_messages SET last_sent_at=NOW(), run_at=run_at + INTERVAL '1 day' WHERE id=$1 AND enabled=TRUE`, [job.id]);
      } else {
        await pool.query(`UPDATE scheduled_messages SET enabled=FALSE,last_sent_at=NOW() WHERE id=$1`, [job.id]);
      }
      sent++;
    } catch (error) { failed++; await onError(error, job); }
  }
  return { checked: due.rowCount, sent, failed };
}

function startScheduler({ pool, telegram, onError = () => {}, intervalMs = 30_000 }) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await dispatchDue(pool, telegram, { onError }); }
    catch (error) { await onError(error, null); }
    finally { running = false; }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { ensureSchedulerSchema, createScheduledMessage, listScheduledMessages, dispatchDue, startScheduler };
