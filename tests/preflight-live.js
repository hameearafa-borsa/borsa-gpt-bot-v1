"use strict";

// Read-only release preflight. It never runs migrations, sends messages, or prints secrets.
require("dotenv").config();
const { Pool } = require("pg");
const { fetchSearch } = require("../modules/deal-sources");

const checks = [];
function record(name, status, detail) {
  checks.push({ name, status, detail: String(detail || "").slice(0, 220) });
  const icon = status === "PASS" ? "✓" : status === "BLOCKED" ? "!" : "✗";
  console.log(`${icon} ${name}: ${status}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
}
async function telegramCall(token, method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.ok) throw new Error(`Telegram ${method} failed (HTTP ${response.status}, ${json.error_code || "no_code"})`);
  return json.result;
}

(async () => {
  let pool;
  try {
    if (!process.env.DATABASE_URL) record("PostgreSQL", "BLOCKED", "DATABASE_URL غير مضبوط؛ لم يُجر أي اتصال");
    else {
      pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 10000, idleTimeoutMillis: 1000 });
      await pool.query("SELECT 1 AS ok");
      record("PostgreSQL connection", "PASS", "SELECT 1 نجح؛ لا كتابة ولا ترحيل");
      const required = {
        authorized_chats: ["chat_id", "chat_type", "owner_user_id", "active"],
        processed_messages: ["chat_id", "message_id", "update_type"],
        price_observations: ["package_sale_price", "price_kind", "observed_at"],
        price_list_runs: ["id", "raw_text", "status"],
        price_list_items: ["run_id", "package_sale_price", "decision"],
        deal_observations: ["fingerprint", "url", "observed_at"],
        deal_publications: ["batch_key", "channel_kind", "status"],
        diagnostic_events: ["module", "stage", "severity", "status"]
      };
      const q = await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name = ANY($1::text[])", [Object.keys(required)]);
      const found = new Map();
      for (const row of q.rows) { if (!found.has(row.table_name)) found.set(row.table_name, new Set()); found.get(row.table_name).add(row.column_name); }
      const missing = [];
      for (const [table, cols] of Object.entries(required)) for (const col of cols) if (!found.get(table)?.has(col)) missing.push(`${table}.${col}`);
      record("PostgreSQL schema compatibility", missing.length ? "FAIL" : "PASS", missing.length ? `أعمدة ناقصة: ${missing.join(", ")}` : `${Object.keys(required).length} جداول وأعمدتها الأساسية موجودة`);
    }
  } catch (error) {
    record("PostgreSQL/schema", "FAIL", `${error.code || error.name}: ${error.message}`);
  } finally {
    if (pool) await pool.end().catch(() => {});
  }

  const token = String(process.env.BOT_TOKEN || "").trim();
  if (!token) record("Telegram Bot API", "BLOCKED", "BOT_TOKEN غير مضبوط؛ لم يُجر اتصال");
  else {
    try {
      const me = await telegramCall(token, "getMe");
      record("Telegram token/getMe", "PASS", `البوت @${me.username || "بدون username"} استجاب؛ لم تُرسل رسالة`);
      const target = String(process.env.DEALS_CHAT_ID || "").trim();
      if (!target) record("Telegram publication destination", "BLOCKED", "DEALS_CHAT_ID غير مضبوط");
      else {
        try {
          const chat = await telegramCall(token, "getChat", { chat_id: target });
          const member = await telegramCall(token, "getChatMember", { chat_id: target, user_id: me.id });
          const canPost = ["creator", "administrator", "member"].includes(member.status) && (member.status !== "administrator" || member.can_post_messages !== false);
          record("Telegram destination access", canPost ? "PASS" : "FAIL", `تم الوصول إلى الوجهة؛ النوع=${chat.type}; حالة البوت=${member.status}; لم تُرسل رسالة`);
        } catch (error) { record("Telegram destination access", "FAIL", error.message); }
      }
    } catch (error) { record("Telegram token/getMe", "FAIL", error.message); }
  }

  if (!process.env.SCRAPER_API_KEY) record("ScraperAPI/Amazon live", "BLOCKED", "SCRAPER_API_KEY غير مضبوط؛ لم يُخترع أي عرض");
  else {
    try {
      const result = await fetchSearch("amazon", "مسحوق غسيل", { timeoutMs: 15000 });
      record("ScraperAPI/Amazon live", result.ok && result.deals.length ? "PASS" : result.ok ? "BLOCKED" : "FAIL", result.ok ? `HTTP ناجح، عروض صالحة مستخرجة=${result.deals.length}; صفر عروض لا يثبت سلامة بنية الصفحة` : result.reason || "source_failed");
    } catch (error) { record("ScraperAPI/Amazon live", "FAIL", error.message); }
  }

  console.log("\nنتيجة preflight:");
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), checks }, null, 2));
  const failures = checks.filter(x => x.status === "FAIL");
  const blocked = checks.filter(x => x.status === "BLOCKED");
  if (failures.length) process.exitCode = 1;
  else if (blocked.length) process.exitCode = 2;
})().catch(error => { console.error("PREFLIGHT_FATAL", error.message); process.exitCode = 1; });
