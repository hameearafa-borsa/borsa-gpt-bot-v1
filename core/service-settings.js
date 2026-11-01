"use strict";

const SERVICES = Object.freeze([
  { key: "chemical", label: "المساعد الكيميائي", scope: "group" },
  { key: "prices", label: "مرصد الأسعار", scope: "group" },
  { key: "lists", label: "قوائم الشركات", scope: "group" },
  { key: "merchants", label: "حفظ بيانات التجار", scope: "group" },
  { key: "deals", label: "نشرات العروض", scope: "both" },
  { key: "catalogs", label: "نشرات الكتالوجات", scope: "both" },
  { key: "weather", label: "الطقس والنشرة الجوية", scope: "both" },
  { key: "economic", label: "النشرة الاقتصادية", scope: "both" }
]);
const SERVICE_KEYS = new Set(SERVICES.map(item => item.key));

function assertService(serviceKey) {
  if (!SERVICE_KEYS.has(serviceKey)) throw new Error("UNKNOWN_SERVICE_SETTING");
}
function normalizeScope(scope, chatId) {
  if (scope === "global") return { scope, chatId: 0 };
  if (scope === "group" && Number.isSafeInteger(Number(chatId)) && Number(chatId) < 0) {
    return { scope, chatId: Number(chatId) };
  }
  throw new Error("INVALID_SERVICE_SETTING_SCOPE");
}
async function getSettings(pool, scope, chatId = 0) {
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  const target = normalizeScope(scope, chatId);
  const result = await pool.query(
    "SELECT service_key, enabled FROM service_settings WHERE scope=$1 AND chat_id=$2",
    [target.scope, target.chatId]
  );
  const saved = new Map((result.rows || []).map(row => [row.service_key, row.enabled === true]));
  return SERVICES.filter(item => scope === "global" || item.scope === "both" || item.scope === scope)
    .map(item => ({ ...item, enabled: saved.has(item.key) ? saved.get(item.key) : true }));
}
async function setServiceSetting(pool, { scope, chatId = 0, serviceKey, enabled, actorId }) {
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  assertService(serviceKey);
  if (typeof enabled !== "boolean") throw new TypeError("SETTING_VALUE_MUST_BE_BOOLEAN");
  const target = normalizeScope(scope, chatId);
  const service = SERVICES.find(item => item.key === serviceKey);
  if (scope === "group" && service.scope === "global") throw new Error("SERVICE_NOT_GROUP_CONFIGURABLE");
  const result = await pool.query(
    `INSERT INTO service_settings(scope,chat_id,service_key,enabled,updated_by,updated_at)
     VALUES($1,$2,$3,$4,$5,NOW())
     ON CONFLICT(scope,chat_id,service_key) DO UPDATE SET
       enabled=EXCLUDED.enabled, updated_by=EXCLUDED.updated_by, updated_at=NOW()
     RETURNING service_key,enabled`,
    [target.scope, target.chatId, serviceKey, enabled, Number(actorId) || null]
  );
  return result.rows?.[0] || { service_key: serviceKey, enabled };
}
async function isServiceEnabled(pool, serviceKey, chatId = null) {
  if (!pool) return true;
  assertService(serviceKey);
  const result = await pool.query(
    `SELECT scope,enabled FROM service_settings
     WHERE service_key=$1 AND ((scope='global' AND chat_id=0) OR (scope='group' AND chat_id=$2))`,
    [serviceKey, Number.isSafeInteger(Number(chatId)) && Number(chatId) < 0 ? Number(chatId) : 0]
  );
  const global = result.rows?.find(row => row.scope === "global");
  const group = result.rows?.find(row => row.scope === "group");
  return (global?.enabled !== false) && (group?.enabled !== false);
}
async function listAuthorizedGroups(pool) {
  const result = await pool.query(
    "SELECT chat_id,chat_type,owner_user_id FROM authorized_chats WHERE active=TRUE ORDER BY chat_id"
  );
  return result.rows || [];
}
async function listOwnedGroups(pool, userId) {
  const result = await pool.query(
    "SELECT chat_id,chat_type,owner_user_id FROM authorized_chats WHERE active=TRUE AND owner_user_id=$1 ORDER BY chat_id",
    [Number(userId)]
  );
  return result.rows || [];
}
module.exports = { SERVICES, SERVICE_KEYS, getSettings, setServiceSetting, isServiceEnabled, listAuthorizedGroups, listOwnedGroups };
