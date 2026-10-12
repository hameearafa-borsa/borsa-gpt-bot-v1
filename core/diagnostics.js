"use strict";
const crypto = require("node:crypto");
const SECRET_KEY = /(token|api[_-]?key|secret|password|database_url|authorization|cookie|credential)/i;
const MAX = 700;
function redactString(value) {
  return String(value ?? "")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[query-redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{12,})\b/g, "[SECRET REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .slice(0, MAX);
}
function safeValue(value) {
  if (value == null) return null;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 12).map(safeValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k,v]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : safeValue(v)]));
  return "[omitted]";
}
function makeReport({ module = "core", stage = "unknown", severity = "error", action = "unknown", error, input, details, chatId, messageId } = {}) {
  const now = new Date();
  return {
    report_id: `V1-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    ts: now.toISOString(), module: redactString(module), stage: redactString(stage), severity,
    action: redactString(action), status: "failed",
    input_summary: input == null ? null : redactString(String(input).replace(/\s+/g, " ")),
    input_fingerprint: input == null ? null : crypto.createHash("sha256").update(String(input)).digest("hex").slice(0, 20),
    chat_id: chatId == null ? null : String(chatId), message_id: messageId == null ? null : String(messageId),
    error: error ? { name: redactString(error.name || "Error"), message: redactString(error.message || String(error)), code: safeValue(error.code), status: safeValue(error.status || error.statusCode), stack: redactString(error.stack || "") } : null,
    details: safeValue(details || {})
  };
}
function formatReport(r) {
  const e = r.error || {};
  const lines = ["🩺 BORSA GPT BOT V1 — DIAGNOSTIC REPORT", `🆔 Report ID: ${r.report_id}`, `🕒 الوقت: ${r.ts}`, `🚦 الخطورة: ${r.severity}`, `🧩 الخدمة: ${r.module}`, `📍 المرحلة: ${r.stage}`, `🎯 العملية: ${r.action}`, `❌ الخطأ: ${e.name || "Error"}${e.code ? ` [${e.code}]` : ""}`, `💬 الرسالة: ${e.message || "—"}`];
  if (r.input_summary) lines.push(`📝 ملخص المدخل: ${r.input_summary}`);
  if (r.details && Object.keys(r.details).length) lines.push(`📦 تفاصيل آمنة: ${JSON.stringify(r.details).slice(0, 800)}`);
  lines.push("🔐 تم حجب الأسرار تلقائيًا.", "🛠️ أرسل هذا التقرير كاملًا إلى ChatGPT للإصلاح.");
  return lines.join("\n").slice(0, 3900);
}
function log(e) {
  const row = { ts: new Date().toISOString(), module: e.module || "core", stage: e.stage || "unknown", severity: e.severity || "info", status: e.status || "ok", input_summary: e.input ? redactString(e.input) : null, input_fingerprint: e.input ? crypto.createHash("sha256").update(String(e.input)).digest("hex").slice(0, 20) : null, details: safeValue(e.details || {}), duration_ms: Number.isFinite(e.durationMs) ? e.durationMs : null, chat_id: e.chatId == null ? null : String(e.chatId), message_id: e.messageId == null ? null : String(e.messageId) };
  const line = JSON.stringify(row);
  if (row.severity === "error") console.error("[DIAG]", line); else if (row.severity === "warn") console.warn("[DIAG]", line); else console.log("[DIAG]", line);
  return row;
}
async function persistReport(db, report) {
  if (!db?.pool) return false;
  try {
    await db.query(`INSERT INTO diagnostic_events(ts,module,stage,severity,status,input_summary,input_fingerprint,details,chat_id,message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [report.ts, report.module, report.stage, report.severity, report.status, report.input_summary, report.input_fingerprint, JSON.stringify({ report_id: report.report_id, action: report.action, error: report.error, details: report.details }), report.chat_id, report.message_id]);
    return true;
  } catch (err) { console.error("[DIAG_PERSIST_FAIL]", redactString(err.message)); return false; }
}
async function emitReport({ bot, db, report, chatId } = {}) {
  console.error("[BORSA_DIAGNOSTIC_REPORT]", JSON.stringify(report));
  await persistReport(db, report);
  const target = chatId || Number(process.env.LOG_CHAT_ID || -1004344288353);
  if (!bot?.telegram?.sendMessage || !target) return false;
  try { await bot.telegram.sendMessage(target, formatReport(report), { disable_web_page_preview: true }); return true; }
  catch (err) { console.error("[DIAG_DELIVERY_FAIL]", redactString(err.message)); return false; }
}
module.exports = { log, makeReport, formatReport, emitReport, persistReport, safeValue, redactString, fingerprint: value => crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16) };
