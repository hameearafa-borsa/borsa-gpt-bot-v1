"use strict";

require("dotenv").config();
const { Telegraf, Markup, session } = require("telegraf");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const cron = require("node-cron");
const axios = require("axios");
const { generateWithFallback, probeProviders, providerStatus, XAI_MODEL, OPENAI_MODEL } = require("./ai");
const APP_VERSION = require("./package.json").version;
const BOT_CREDIT = "مدعوم تقنياً بمحرك ChatGPT";
const {
  setupModeration,
  moderationMiddleware,
  isChatAdmin,
  undoKeyboard,
} = require("./moderation");
const {
  setupPrices,
  ensurePricesSchema,
  capturePricesFromMessage,
  searchPrices,
  deletePrice,
  formatDailyDigest,
  formatSearchResults,
} = require("./prices");
const { setupDeals, fetchDealsReport } = require("./deals");

// ============ المعرفات والصلاحيات ============
const OWNER_ID = String(process.env.OWNER_ID || "831621854");
const DESIGNATED_ADMIN_ID = String(process.env.DESIGNATED_ADMIN_ID || "5256328556");
const AUTHORIZED_IDS = [...new Set([OWNER_ID, DESIGNATED_ADMIN_ID, String(process.env.ADMIN_ID || OWNER_ID)])];
const ALLOWED_CHAT_IDS = String(process.env.ALLOWED_CHAT_IDS || "1556414386,4461526287")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "chat_member",
  "my_chat_member",
  "chat_join_request",
];

const MUTE_PERMISSIONS_OFF = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_send_media_messages: false,
};
const MUTE_PERMISSIONS_ON = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_send_media_messages: true,
};

if (!process.env.BOT_TOKEN) {
  console.error("❌ BOT_TOKEN غير موجود في متغيرات البيئة.");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

function isAuthorizedAdmin(userId) {
  if (!userId) return false;
  return AUTHORIZED_IDS.includes(String(userId));
}

function commandArg(ctx) {
  const text = ctx.message?.text || "";
  return text.replace(/^\/\S+(?:@\w+)?\s*/i, "").trim();
}

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatChatId(id) {
  if (id === undefined || id === null || id === "") return null;
  const str = String(id).trim();
  if (str.startsWith("@") || str.startsWith("-")) return str;
  if (/^\d{10,}$/.test(str)) return `-100${str}`;
  return str;
}

function parseJsonLoose(text) {
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.search(/[\[{]/);
    const end = Math.max(clean.lastIndexOf("]"), clean.lastIndexOf("}"));
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error("تعذر قراءة JSON من نموذج الذكاء الاصطناعي");
  }
}

function cleanPhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "").trim();
}

function lastActiveTs(value) {
  if (typeof value === "number") return value;
  return value?.t || 0;
}

// ============ تنبيهات الأخطاء (مع تهدئة) ============
let lastAlertAt = 0;
async function sendErrorAlert(error, source = "غير محدد") {
  const now = Date.now();
  if (now - lastAlertAt < 30_000) {
    console.error(`⚠️ (${source})`, error?.message || error);
    return;
  }
  lastAlertAt = now;
  const time = new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" });
  const details = String(error?.message || error).slice(0, 1200);
  const alertMsg =
    `تنبيه: خطأ في البوت\n` +
    `التوقيت: ${time}\n` +
    `المصدر: ${source}\n\n` +
    `<pre>${escHtml(details)}</pre>`;
  try {
    await bot.telegram.sendMessage(OWNER_ID, alertMsg, { parse_mode: "HTML" });
  } catch (e) {
    console.error("❌ فشل إرسال إشعار الخطأ:", e.message);
  }
}

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err);
  sendErrorAlert(err, "Uncaught Exception");
});
process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled Rejection:", reason);
  sendErrorAlert(reason, "Unhandled Rejection");
});
bot.catch((err, ctx) => {
  console.error(`⚠️ [${ctx.updateType}]`, err.message);
  sendErrorAlert(err, `تحديث ${ctx.updateType}`);
});

// ============ قاعدة البيانات ============
const hasDatabase = Boolean(process.env.DATABASE_URL);
const pool = hasDatabase
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
    })
  : null;

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS merchants (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      activity TEXT,
      location TEXT,
      phone TEXT UNIQUE,
      telegram_username TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function kvGet(key, fallback) {
  if (pool) {
    try {
      const res = await pool.query("SELECT value FROM bot_state WHERE key = $1", [key]);
      if (res.rows[0]) return res.rows[0].value;
    } catch (e) {
      console.error("kvGet", key, e.message);
    }
  }
  return fallback;
}

async function kvSet(key, value) {
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO bot_state (key, value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
      return;
    } catch (e) {
      console.error("kvSet", key, e.message);
    }
  }
}

const SETTINGS_FILE = path.join(__dirname, "settings.json");
const ALLOWED_FILE = path.join(__dirname, "allowed_links.json");
const SCHEDULED_FILE = path.join(__dirname, "scheduled.json");
const ACTIVITY_FILE = path.join(__dirname, "activity.json");
const WARNINGS_FILE = path.join(__dirname, "warnings.json");

function saveData(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`❌ حفظ ${path.basename(file)}:`, e.message);
  }
}
function loadData(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* ملف تالف */
  }
  return fallback;
}

let logChannelId = process.env.LOG_CHANNEL_ID || null;
let scheduledPosts = [];
const userMsgTracker = new Map();
const userRepeatTracker = new Map();
const userMediaTracker = new Map();
const userActivity = new Map();
const userWarnings = new Map();

let activitySaveTimer = null;
function scheduleSaveActivity() {
  if (activitySaveTimer) return;
  activitySaveTimer = setTimeout(() => {
    activitySaveTimer = null;
    saveActivity();
  }, 15_000);
}

const DEFAULT_WELCOME_TEXT = `أهلاً بك في بورصة المنظفات لأصحاب المحلات
يسعدنا جداً انضمامك إلى منصتنا المتخصصة في مجال المنظفات، الورقيات، ومستحضرات التجميل. تم إنشاء هذه المجموعة لتكون مظلة تجمع أصحاب المحلات والتجار لتبادل الخبرات وحماية مصالحهم.
أهدافنا الأساسية التي نعمل معاً لتحقيقها:
نشر الوعي والمعرفة: مشاركة الخبرات والنصائح لتطوير وإدارة محلات المنظفات بشكل احترافي.
مقاومة الجشع والاستغلال: الوقوف معاً ضد سياسات حرق الأسعار والممارسات التجارية غير العادلة في السوق.
تداول أسعار السوق: توفير مساحة شفافة وموثوقة لمعرفة الأسعار الحقيقية والمتداولة بين التجار.
متابعة الأسعار اليومية: رصد وتحديث مستمر لحركة الأسعار لحظة بلحظة لمساعدتك في اتخاذ قرارات الشراء والبيع الصحيحة.
تطوير تجارة أصحاب المحلات: تقديم الدعم والأفكار التي تساهم في زيادة أرباحك وتوسيع نشاطك التجاري.
تنويه هام للاستمرار في الجروب: الجروب قائم على المنفعة المتبادلة، لذا يُشترط على جميع الأعضاء التفاعل والمشاركة النشطة من خلال:
نشر أسعار شراء المنتجات أولاً بأول لتوثيق حركة السوق.
الرد على استفسارات وأسئلة زملائك من الأعضاء وتقديم المساعدة.
يرجى العلم أن الأعضاء غير المتفاعلين أو المكتفين بالمشاهدة فقط سيتم حظرهم وإزالتهم من الجروب نهائياً للحفاظ على حيوية المنصة وجديتها.
نتمنى لك رحلة موفقة وتجارة رابحة معنا!`;

const DEFAULT_FAREWELL_TEXT = `مرحبا
لاحظنا مغادرتك لجروبنا على تليجرام، وسعدنا جداً بتواجدك معنا خلال الفترة الماضية. يسعدنا دائماً معرفة رأي أعضائنا لتطوير المجموعة وتحسين التجربة للجميع، لذا نرجو منك إخبارنا بشكل سريع عن سبب مغادرتك، وهل هناك أي ملاحظات أو مقترحات تود مشاركتها معنا؟ نتمنى لك كل التوفيق، وباب الجروب مفتوح لك دائماً إذا رغبت في العودة.
يمكنك إرسال رسالة خاصة بالسبب والمقترحات إلى:
@AbdalhamidHammad`;

const DEFAULT_ADMIN_CONTACT = "@AbdalhamidHammad";

let settings = {
  antiLink: true,
  antiBadWords: true,
  welcome: false,
  farewell: false,
  adminContact: DEFAULT_ADMIN_CONTACT,
  antiPorn: true,
  logActions: true,
  antiSpam: true,
  antiRepeat: true,
  antiForward: true,
  autoPrice: true,
  maxFloodMsgs: 8,
  maxPhotos: 4,
  maxVideos: 2,
  penaltyType: "mute",
  penaltyDuration: 60,
  warnAction: "mute",
  warnMax: 3,
  warnMuteDays: 15,
  autoApproveJoin: true,
  deleteServiceMessages: false,
  welcomeText: DEFAULT_WELCOME_TEXT,
  farewellText: DEFAULT_FAREWELL_TEXT,
  _v: 3,
};

const DEFAULT_ALLOWED_LINKS = [
  "t.me/c/1556414386",
  "t.me/c/4461526287",
  "amazon.eg",
  "noon.com",
  "jumia.com",
  "jumia.com.eg",
  "carrefouregypt.com",
  "kazyon.com",
  "facebook.com",
  "instagram.com",
  "google.com",
];

let allowedLinks = DEFAULT_ALLOWED_LINKS.slice();

function persistLocal() {
  saveData(SETTINGS_FILE, { settings, logChannelId });
  saveData(ALLOWED_FILE, allowedLinks);
  saveData(SCHEDULED_FILE, scheduledPosts);
}

async function persistAll() {
  persistLocal();
  await Promise.all([
    kvSet("settings", { settings, logChannelId }),
    kvSet("allowed_links", allowedLinks),
    kvSet("scheduled", scheduledPosts),
  ]);
}

function saveAllSettings() {
  persistAll().catch((e) => console.error("saveAllSettings", e.message));
}

function saveActivity() {
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  userActivity.forEach((v, k) => {
    if (lastActiveTs(v) < cutoff) userActivity.delete(k);
  });
  if (userActivity.size > 12000) {
    const sorted = [...userActivity.entries()].sort((a, b) => lastActiveTs(a[1]) - lastActiveTs(b[1]));
    sorted.slice(0, userActivity.size - 10000).forEach(([k]) => userActivity.delete(k));
  }
  const obj = {};
  userActivity.forEach((v, k) => {
    obj[k] = v;
  });
  saveData(ACTIVITY_FILE, obj);
  kvSet("activity", obj).catch(() => {});
}

function saveWarnings() {
  const obj = {};
  userWarnings.forEach((v, k) => {
    obj[k] = v;
  });
  saveData(WARNINGS_FILE, obj);
  kvSet("warnings", obj).catch(() => {});
}

function saveAllowed(list) {
  allowedLinks = list;
  persistAll().catch(() => {});
}

function loadAllowed() {
  return allowedLinks.length ? allowedLinks : DEFAULT_ALLOWED_LINKS;
}

function resetUserTrackers(userId) {
  const id = Number(userId);
  userMsgTracker.delete(id);
  userRepeatTracker.delete(id);
  userMediaTracker.delete(id);
  userMediaTracker.delete(`p:${id}`);
  userMediaTracker.delete(`v:${id}`);
  userWarnings.set(String(id), 0);
  saveWarnings();
}

async function initStorage() {
  await ensureSchema();
  setupPrices({
    pool,
    generateWithFallback,
    parseJsonLoose,
    getSettings: () => settings,
    logAction,
    escHtml,
    isPrivileged: async (ctx) =>
      isAuthorizedAdmin(ctx.from?.id) || isChatAdmin(ctx, ctx.from?.id),
  });
  setupDeals({
    generateWithFallback,
    parseJsonLoose,
    escHtml,
  });
  await ensurePricesSchema();
  const remoteSettings = await kvGet("settings", null);
  const fileSettings = loadData(SETTINGS_FILE, null);
  const packed = remoteSettings || fileSettings;
  if (packed) {
    settings = { ...settings, ...(packed.settings || packed) };
    logChannelId = packed.logChannelId || logChannelId;
  }
  allowedLinks = (await kvGet("allowed_links", null)) || loadData(ALLOWED_FILE, DEFAULT_ALLOWED_LINKS);
  if (!Array.isArray(allowedLinks) || allowedLinks.length === 0) allowedLinks = DEFAULT_ALLOWED_LINKS.slice();
  scheduledPosts = (await kvGet("scheduled", null)) || loadData(SCHEDULED_FILE, []);
  const activityRaw = (await kvGet("activity", null)) || loadData(ACTIVITY_FILE, {});
  Object.entries(activityRaw || {}).forEach(([k, v]) => userActivity.set(k, v));
  const warnRaw = (await kvGet("warnings", null)) || loadData(WARNINGS_FILE, {});
  Object.entries(warnRaw || {}).forEach(([k, v]) => userWarnings.set(k, v));
  if (!settings._v || settings._v < 3) {
    settings.welcome = false;
    settings.farewell = false;
    settings.autoPrice = settings.autoPrice !== false;
    if (!settings.maxFloodMsgs || settings.maxFloodMsgs < 8) settings.maxFloodMsgs = 8;
    settings._v = 3;
    saveAllSettings();
  }
}

async function logAction(text) {
  if (!settings.logActions) return;
  const targetChat = formatChatId(logChannelId || process.env.LOG_CHANNEL_ID);
  if (!targetChat) return;
  try {
    await bot.telegram.sendMessage(targetChat, text);
  } catch (e) {
    console.error("❌ سجل الإجراءات:", e.message);
  }
}

async function targetBroadcastChat() {
  return formatChatId(logChannelId || process.env.LOG_CHANNEL_ID);
}

async function isNsfwImage(photoUrl) {
  const apiUser = process.env.SIGHTENGINE_USER;
  const apiSecret = process.env.SIGHTENGINE_SECRET;
  if (!apiUser || !apiSecret) return false;
  try {
    const checkUrl =
      `https://api.sightengine.com/1.0/check.json?url=${encodeURIComponent(photoUrl)}` +
      `&models=nudity-2.0&api_user=${apiUser}&api_secret=${apiSecret}`;
    const response = await fetch(checkUrl);
    const data = await response.json();
    if (data.status === "success" && data.nudity) {
      const n = data.nudity;
      return n.sexual_activity > 0.5 || n.sexual_display > 0.5 || n.erotica > 0.7;
    }
  } catch (error) {
    console.error("❌ Sightengine:", error.message);
  }
  return false;
}

async function applyPenalty(ctx, userId, type, reason) {
  const durationMin = settings.penaltyDuration || 0;
  const until = durationMin > 0 ? Math.floor(Date.now() / 1000) + durationMin * 60 : 0;
  const muteDays = settings.warnMuteDays || 15;
  const warnUntil =
    type === "mute" && until === 0
      ? Math.floor(Date.now() / 1000) + muteDays * 24 * 3600
      : until || undefined;
  const chatId = ctx.chat.id;
  const name = escHtml(ctx.from?.first_name || String(userId));
  try {
    if (type === "kick") {
      await ctx.telegram.banChatMember(chatId, userId);
      await ctx.telegram.unbanChatMember(chatId, userId, { only_if_banned: true });
    } else if (type === "ban") {
      await ctx.telegram.banChatMember(chatId, userId, until ? { until_date: until } : {});
    } else {
      await ctx.telegram.restrictChatMember(chatId, userId, {
        permissions: MUTE_PERMISSIONS_OFF,
        until_date: warnUntil,
      });
      type = "mute";
    }
    resetUserTrackers(userId);
    const label = type === "ban" ? "حظر" : type === "kick" ? "طرد" : "كتم";
    await ctx.reply(
      `تم تطبيق عقوبة (${label}) على ${name}\nالسبب: ${escHtml(reason)}`,
      { parse_mode: "HTML", ...undoKeyboard(type === "kick" ? "ban" : type, userId) }
    );
    await logAction(`عقوبة ${label} — ${userId} — ${reason}`);
  } catch (e) {
    console.error("applyPenalty", e.message);
    sendErrorAlert(e, `عقوبة ${type}`);
  }
}

// ============ تجّار + AI موحّد ============
async function saveMerchantFromText(text) {
  const response = await generateWithFallback(
    `استخرج بيانات كافة التجار المذكورين في النص التالي. إن لم يوجد رقم هاتف صحيح تجاهل السجل.\n${text}`,
    {
      responseMimeType: "application/json",
      responseSchema: {
        type: "array",
        description: "قائمة التجار المستخرجين من النص",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "اسم التاجر أو المحل" },
            activity: { type: "string", description: "النشاط التجاري" },
            location: { type: "string", description: "المحافظة أو المدينة" },
            phone: { type: "string", description: "رقم الهاتف" },
            telegram_username: {
              type: "string",
              description: "يوزر التليجرام بدون @ إن وُجد",
            },
          },
          required: ["name", "activity", "location", "phone", "telegram_username"],
          additionalProperties: false,
        },
      },
    }
  );

  const merchants = parseJsonLoose(response.text);
  if (!Array.isArray(merchants)) return [];
  if (!pool) throw new Error("DATABASE_URL غير مضبوط");

  const savedMerchants = [];
  for (const merchant of merchants) {
    const clean = cleanPhone(merchant.phone);
    if (!clean) continue;
    const cleanUsername = merchant.telegram_username
      ? String(merchant.telegram_username).replace(/^@/, "").trim()
      : "";
    const check = await pool.query("SELECT * FROM merchants WHERE phone = $1", [clean]);
    if (check.rows.length) {
      const res = await pool.query(
        `UPDATE merchants
         SET name = $1, activity = $2, location = $3,
             telegram_username = COALESCE(NULLIF($4, ''), telegram_username),
             updated_at = NOW()
         WHERE phone = $5 RETURNING *`,
        [merchant.name, merchant.activity || "غير محدد", merchant.location || "غير محدد", cleanUsername, clean]
      );
      savedMerchants.push({ ...res.rows[0], isUpdated: true });
    } else {
      const res = await pool.query(
        `INSERT INTO merchants (name, activity, location, phone, telegram_username)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [merchant.name, merchant.activity || "غير محدد", merchant.location || "غير محدد", clean, cleanUsername]
      );
      savedMerchants.push({ ...res.rows[0], isUpdated: false });
    }
  }
  return savedMerchants;
}

async function searchMerchants(keyword) {
  if (!pool) throw new Error("DATABASE_URL غير مضبوط");
  const q = `
    SELECT * FROM merchants
    WHERE name ILIKE $1 OR location ILIKE $1 OR activity ILIKE $1 OR phone ILIKE $1
    ORDER BY id DESC LIMIT 20`;
  const result = await pool.query(q, [`%${keyword}%`]);
  return result.rows;
}

function formatMerchant(m, extra = "") {
  const tg = m.telegram_username ? `@${escHtml(m.telegram_username)}` : "غير متوفر";
  return (
    `${extra}` +
    `ID: <code>${m.id}</code>\n` +
    `الاسم: ${escHtml(m.name)}\n` +
    `النشاط: ${escHtml(m.activity)}\n` +
    `العنوان: ${escHtml(m.location)}\n` +
    `الهاتف: ${escHtml(m.phone)}\n` +
    `التليجرام: ${tg}`
  );
}

// ============ الأسعار والطقس ============
async function fetchUsdEgp() {
  try {
    const usdRes = await axios.get("https://open.er-api.com/v6/latest/USD", { timeout: 8000 });
    if (usdRes.data?.rates?.EGP) return Number(usdRes.data.rates.EGP);
  } catch {
    /* fallback */
  }
  try {
    const res = await axios.get(
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
      { timeout: 8000 }
    );
    return Number(res.data?.usd?.egp) || 0;
  } catch {
    return 0;
  }
}

async function fetchGoldUsd() {
  try {
    const goldRes = await axios.get("https://api.gold-api.com/price/XAU", { timeout: 8000 });
    return Number(goldRes.data?.price) || 0;
  } catch {
    return 0;
  }
}

async function fetchBrentUsd() {
  const headers = { "User-Agent": "Mozilla/5.0" };
  for (const host of ["query1", "query2"]) {
    try {
      const res = await axios.get(
        `https://${host}.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=1d`,
        { headers, timeout: 8000 }
      );
      const price = res.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) return Number(price);
    } catch {
      /* التالي */
    }
  }
  return 0;
}

async function fetchMarketPrices() {
  try {
    const [usdEgp, goldOunceUsd, brentUsd] = await Promise.all([
      fetchUsdEgp(),
      fetchGoldUsd(),
      fetchBrentUsd(),
    ]);
    let gold21Egp = 0;
    let goldSovereignEgp = 0;
    if (goldOunceUsd > 0 && usdEgp > 0) {
      const gold24EgpGram = (goldOunceUsd / 31.1034768) * usdEgp;
      gold21Egp = gold24EgpGram * (21 / 24);
      goldSovereignEgp = gold21Egp * 8;
    }
    return {
      usdEgp: usdEgp ? usdEgp.toFixed(2) : "غير متاح",
      brent: brentUsd ? brentUsd.toFixed(2) : "غير متاح",
      gold21: gold21Egp ? Math.round(gold21Egp) : "غير متاح",
      goldSovereign: goldSovereignEgp ? Math.round(goldSovereignEgp) : "غير متاح",
    };
  } catch (error) {
    sendErrorAlert(error, "fetchMarketPrices");
    return null;
  }
}

async function generateMarketReport() {
  const prices = await fetchMarketPrices();
  if (!prices) return null;
  return (
    `<b>نشرة الأسعار الاقتصادية اليومية – بورصة المنظفات</b>\n\n` +
    `سعر الدولار مقابل الجنيه: ${prices.usdEgp} ج.م\n` +
    `سعر برميل خام برنت: $${prices.brent}\n` +
    `جرام الذهب عيار 21: ${prices.gold21} ج.م (تقريبي العالمية)\n` +
    `سعر الجنيه الذهب: ${prices.goldSovereign} ج.م (تقريبي)\n\n` +
    `نتمنى لكم يوماً موفقاً وتجارة رابحة.`
  );
}

const WEATHER_CITIES = [
  { name: "الإسكندرية", lat: 31.2001, lon: 29.9187 },
  { name: "القاهرة", lat: 30.0444, lon: 31.2357 },
  { name: "المنيا", lat: 28.0871, lon: 30.7618 },
  { name: "الأقصر", lat: 25.6872, lon: 32.6396 },
];

async function generateWeatherReport() {
  try {
    const requests = WEATHER_CITIES.map((city) => {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
        `&current_weather=true&timezone=Africa/Cairo`;
      return fetch(url)
        .then((res) => res.json())
        .then((data) => ({ city, data }))
        .catch(() => ({ city, data: null }));
    });
    const results = await Promise.all(requests);
    let report = `<b>نشرة الطقس اليومية – بورصة المنظفات</b>\n\n`;
    for (const { city, data } of results) {
      if (data?.current_weather) {
        const temp = Math.round(data.current_weather.temperature);
        const wind = Math.round(data.current_weather.windspeed);
        report += `${escHtml(city.name)}:\n• الحرارة: ${temp}°م\n• سرعة الرياح: ${wind} كم/س\n\n`;
      } else {
        report += `${escHtml(city.name)}: غير متاح حالياً\n\n`;
      }
    }
    report += "نتمنى لكم يوماً موفقاً وتجارة رابحة.";
    return report;
  } catch (e) {
    sendErrorAlert(e, "generateWeatherReport");
    return null;
  }
}

async function sendToLog(html) {
  const target = await targetBroadcastChat();
  if (!target) {
    console.warn("⚠️ لا توجد قناة سجل لإرسال النشرة.");
    return false;
  }
  await bot.telegram.sendMessage(target, html, { parse_mode: "HTML" });
  return true;
}

async function sendPriceDigest(html) {
  const extra = { parse_mode: "HTML", disable_web_page_preview: true };
  const sent = new Set();
  const groupId = formatChatId(ALLOWED_CHAT_IDS[0]);
  const logId = formatChatId(logChannelId || process.env.LOG_CHANNEL_ID);
  for (const chatId of [groupId, logId]) {
    if (!chatId || sent.has(chatId)) continue;
    try {
      await bot.telegram.sendMessage(chatId, html, extra);
      sent.add(chatId);
    } catch (e) {
      console.warn("digest", chatId, e.message);
    }
  }
  return sent.size > 0;
}

function startSchedulers() {
  cron.schedule(
    "0 14,20 * * *",
    async () => {
      try {
        const report = await generateWeatherReport();
        if (report) await sendToLog(report);
      } catch (e) {
        sendErrorAlert(e, "نشرة الطقس التلقائية");
      }
    },
    { timezone: "Africa/Cairo" }
  );

  cron.schedule(
    "0 10 * * *",
    async () => {
      try {
        const report = await generateMarketReport();
        if (report) await sendToLog(report);
      } catch (e) {
        sendErrorAlert(e, "نشرة الأسعار التلقائية");
      }
    },
    { timezone: "Africa/Cairo" }
  );

  cron.schedule(
    "* * * * *",
    async () => {
      if (!scheduledPosts.length) return;
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" }));
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const stamp = `${hh}:${mm}`;
      const today = now.toISOString().slice(0, 10);
      for (const post of scheduledPosts) {
        if (!post.time || post.time !== stamp) continue;
        if (post.lastSent === today) continue;
        const target = formatChatId(post.chatId) || (await targetBroadcastChat());
        if (!target) continue;
        try {
          await bot.telegram.sendMessage(target, post.text);
          post.lastSent = today;
        } catch (e) {
          sendErrorAlert(e, "رسالة مجدولة");
        }
      }
      persistAll().catch(() => {});
    },
    { timezone: "Africa/Cairo" }
  );

  cron.schedule(
    "0 21 * * *",
    async () => {
      try {
        const report = await formatDailyDigest();
        if (report) await sendPriceDigest(report);
      } catch (e) {
        sendErrorAlert(e, "ملخص أسعار المساء");
      }
    },
    { timezone: "Africa/Cairo" }
  );

  console.log("⏰ الجداول تعمل بتوقيت القاهرة (طقس / سوق / أسعار منظفات / رسائل مجدولة).");
}

// ============ لوحات التحكم ============
function onOff(v) {
  return v ? "تشغيل" : "إيقاف";
}

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("مانع الرسائل المزعجة", "sub_antispam"),
      Markup.button.callback("مانع التكرار", "sub_antirepeat"),
    ],
    [
      Markup.button.callback("الترحيب", "sub_welcome"),
      Markup.button.callback("الوداع", "sub_farewell"),
    ],
    [Markup.button.callback(`رصد الأسعار التلقائي: ${onOff(settings.autoPrice)}`, "toggle_autoprice")],
    [
      Markup.button.callback("الإنذارات", "sub_warnings"),
      Markup.button.callback("الروابط المسموحة", "sub_links"),
    ],
    [
      Markup.button.callback("عقوبات المخالفات", "sub_penalties"),
      Markup.button.callback("رسائل مجدولة", "sub_scheduled"),
    ],
    [
      Markup.button.callback("الأعضاء الخاملون", "sub_inactive"),
      Markup.button.callback("قناة السجل", "sub_logchannel"),
    ],
    [
      Markup.button.callback("المزيد", "main_page2"),
      Markup.button.callback("إغلاق", "close_menu"),
    ],
  ]);
}

function page2MenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`فلتر الروابط: ${onOff(settings.antiLink)}`, "toggle_link"),
      Markup.button.callback(`فلتر الإباحية: ${onOff(settings.antiPorn)}`, "toggle_porn"),
    ],
    [
      Markup.button.callback(`سجل الإجراءات: ${onOff(settings.logActions)}`, "toggle_log"),
      Markup.button.callback(`الألفاظ: ${onOff(settings.antiBadWords)}`, "toggle_badwords"),
    ],
    [
      Markup.button.callback(
        `قبول الانضمام: ${onOff(settings.autoApproveJoin)}`,
        "toggle_autojoin"
      ),
    ],
    [
      Markup.button.callback(
        `حذف رسائل الخدمة: ${onOff(settings.deleteServiceMessages)}`,
        "toggle_service"
      ),
    ],
    [Markup.button.callback("العودة", "main_page1")],
    [Markup.button.callback("إغلاق", "close_menu")],
  ]);
}

function antiSpamKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`نظام السبام: ${onOff(settings.antiSpam)}`, "toggle_antispam")],
    [Markup.button.callback(`منع التوجيه: ${onOff(settings.antiForward)}`, "toggle_antiforward")],
    [
      Markup.button.callback(`حد الصور: ${settings.maxPhotos}`, "set_photos_limit"),
      Markup.button.callback(`حد الفيديو: ${settings.maxVideos}`, "set_videos_limit"),
    ],
    [Markup.button.callback("رجوع", "main_page1")],
  ]);
}

function antiRepeatKeyboard() {
  const nums = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20];
  const rows = [];
  for (let i = 0; i < nums.length; i += 4) {
    rows.push(
      nums.slice(i, i + 4).map((n) =>
        Markup.button.callback(n === settings.maxFloodMsgs ? `${n} •` : String(n), `set_repeat_${n}`)
      )
    );
  }
  rows.push([Markup.button.callback("رجوع", "main_page1")]);
  return Markup.inlineKeyboard(rows);
}

function warningsKeyboard() {
  const act = settings.warnAction;
  const max = settings.warnMax;
  const mark = (key, label) => (act === key ? `${label} •` : label);
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(mark("kick", "طرد"), "set_warn_act_kick"),
      Markup.button.callback(mark("none", "بلا عقوبة"), "set_warn_act_none"),
    ],
    [
      Markup.button.callback(mark("mute", "كتم"), "set_warn_act_mute"),
      Markup.button.callback(mark("ban", "حظر"), "set_warn_act_ban"),
    ],
    [Markup.button.callback("عدد الإنذارات", "noop")],
    [2, 3, 4, 5, 6].map((n) =>
      Markup.button.callback(max === n ? `${n} •` : String(n), `set_warn_max_${n}`)
    ),
    [Markup.button.callback("رجوع", "main_page1")],
  ]);
}

function penaltyKeyboard() {
  const pType = settings.penaltyType === "mute" ? "كتم" : "حظر";
  return Markup.inlineKeyboard([
    [Markup.button.callback(`النوع الحالي: ${pType}`, "toggle_penalty_type")],
    [
      Markup.button.callback(settings.penaltyDuration === 60 ? "ساعة •" : "ساعة", "set_dur_60"),
      Markup.button.callback(settings.penaltyDuration === 1440 ? "24 ساعة •" : "24 ساعة", "set_dur_1440"),
      Markup.button.callback(settings.penaltyDuration === 0 ? "دائمة •" : "دائمة", "set_dur_0"),
    ],
    [Markup.button.callback("رجوع", "main_page1")],
  ]);
}

function allowedLinksKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("إضافة رابط مسموح", "add_allowed_link")],
    [Markup.button.callback("عرض الروابط المسموحة", "view_allowed_links")],
    [Markup.button.callback("إعادة الضبط الافتراضي", "clear_allowed_links")],
    [Markup.button.callback("رجوع", "main_page1")],
  ]);
}

function welcomeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`تفعيل الترحيب: ${onOff(settings.welcome)}`, "toggle_welcome")],
    [Markup.button.callback("رجوع", "main_page1")],
  ]);
}

function farewellKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`رسائل الوداع: ${onOff(settings.farewell)}`, "toggle_farewell")],
    [Markup.button.callback("تغيير حساب الإدارة", "set_admin_handle")],
    [Markup.button.callback("رجوع", "main_page1")],
  ]);
}

function inactiveKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("فحص الخاملين (+30 يوم)", "check_inactive_count")],
    [Markup.button.callback("تنبيه الخاملين عبر الخاص", "send_inactive_pm")],
    [Markup.button.callback("رجوع", "main_page1")],
  ]);
}

function scheduledKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("إضافة رسالة مجدولة", "add_scheduled_post")],
    [Markup.button.callback("عرض الرسائل المجدولة", "list_scheduled_posts")],
    [Markup.button.callback("مسح الرسائل المجدولة", "clear_scheduled_posts")],
    [Markup.button.callback("رجوع", "main_page1")],
  ]);
}

const ADMIN_CB = /^(sub_|toggle_|set_|main_|close_menu|add_|view_|clear_|check_|send_inactive|list_|noop)/;

async function safeEdit(ctx, text, extra) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (e) {
    if (!/not modified|message to edit not found|query is too old/i.test(e.message || "")) {
      throw e;
    }
  }
}

async function safeCb(ctx, text) {
  try {
    await ctx.answerCbQuery(text || undefined);
  } catch {
    /* انتهت صلاحية الاستعلام */
  }
}

setupModeration({
  getSettings: () => settings,
  loadAllowed,
  userMsgTracker,
  userRepeatTracker,
  userMediaTracker,
  userActivity,
  userWarnings,
  saveWarnings,
  scheduleSaveActivity,
  isAuthorizedAdmin,
  isNsfwImage,
  applyPenalty,
  logAction,
  sendErrorAlert,
  escHtml,
  AUTHORIZED_IDS,
  ALLOWED_CHAT_IDS,
  DEFAULT_WELCOME_TEXT,
  DEFAULT_FAREWELL_TEXT,
  DEFAULT_ADMIN_CONTACT,
});

bot.use(session({ defaultSession: () => ({ step: null, draft: {} }) }));
bot.use(moderationMiddleware);

bot.on("message", (ctx, next) => {
  capturePricesFromMessage(ctx).catch((e) => sendErrorAlert(e, "رصد سعر"));
  return next();
});

bot.use(async (ctx, next) => {
  if (!ctx.callbackQuery) return next();
  const data = ctx.callbackQuery.data || "";
  if (data.startsWith("undo_penalty_")) {
    if (isAuthorizedAdmin(ctx.from?.id) || (await isChatAdmin(ctx, ctx.from?.id))) return next();
    return safeCb(ctx, "هذه العملية للمشرفين فقط");
  }
  if (ADMIN_CB.test(data)) {
    if (!isAuthorizedAdmin(ctx.from?.id)) {
      return ctx.answerCbQuery("هذه اللوحة مخصصة لإدارة البوت فقط.", { show_alert: true }).catch(() => {});
    }
  }
  return next();
});

const ADMIN_COMMANDS = [
  { command: "start", description: "بدء تشغيل البوت" },
  { command: "settings", description: "لوحة التحكم" },
  { command: "setup", description: "تعيين قناة السجل" },
  { command: "id", description: "عرض معرف المحادثة" },
  { command: "save", description: "حفظ بيانات تاجر" },
  { command: "find", description: "بحث عن تاجر" },
  { command: "merchant", description: "عرض تاجر بالرقم" },
  { command: "delete", description: "حذف تاجر" },
  { command: "weather", description: "نشرة الطقس" },
  { command: "market", description: "نشرة السوق" },
  { command: "as3ar", description: "عرض أسعار المنظفات المرصودة" },
  { command: "as3arday", description: "ملخص أسعار اليوم" },
  { command: "orood", description: "عروض أمازون ونون وجوميا وكارفور" },
  { command: "delprice", description: "حذف رصد سعر بالرقم" },
  { command: "status", description: "حالة البوت" },
  { command: "aitest", description: "فحص مفاتيح الذكاء الاصطناعي" },
];

function guardAdmin(ctx) {
  return isAuthorizedAdmin(ctx.from?.id);
}

async function guardStaff(ctx) {
  if (isAuthorizedAdmin(ctx.from?.id)) return true;
  return isChatAdmin(ctx, ctx.from?.id);
}

bot.command("start", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  await ctx.reply(`أهلاً بك. أنا بوت حماية وإدارة مجموعة بورصة المنظفات.\nاستخدم /settings لفتح لوحة التحكم.\n\n${BOT_CREDIT}`);
});

bot.command("id", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  await ctx.reply(
    `chat: <code>${ctx.chat.id}</code>\nuser: <code>${ctx.from.id}</code>`,
    { parse_mode: "HTML" }
  );
});

bot.command("status", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  const mem = process.memoryUsage();
  await ctx.reply(
    `<b>حالة البوت</b>\n` +
      `التشغيل: ${Math.round(process.uptime() / 60)} دقيقة\n` +
      `الذاكرة: ${Math.round(mem.rss / 1024 / 1024)} MB\n` +
      `قاعدة البيانات: ${pool ? "متصلة" : "ملفات محلية"}\n` +
      `قناة السجل: ${escHtml(String(logChannelId || "غير محددة"))}\n` +
      `التجار الخاملون (تتبع): ${userActivity.size}\n` +
      `AI: OpenAI=${providerStatus().OpenAI.configured} — xAI=${providerStatus().xAI.configured} — Gemini=${providerStatus().Gemini.configured ? "نعم" : "لا"}`,
    { parse_mode: "HTML" }
  );
});

bot.command("aitest", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  const loading = await ctx.reply("جاري فحص مفاتيح الذكاء الاصطناعي...", { disable_notification: true });
  try {
    const result = await probeProviders({ force: true });
    const lines = (result.results || []).map((r) =>
      `${r.ok ? "✅" : "❌"} ${r.label}${r.model ? ` — ${r.model}` : ""}${r.status ? ` — HTTP ${r.status}` : ""}${r.error ? ` — ${escHtml(r.error)}` : ""}`
    );
    const ps = providerStatus();
    lines.push(`\nالأولوية: OpenAI-1 → OpenAI-2 → xAI-1 → xAI-2 → Gemini`);
    lines.push(`OpenAI المفاتيح المضبوطة: ${ps.OpenAI.configured} — النموذج: ${OPENAI_MODEL}`);
    lines.push(`xAI المفاتيح المضبوطة: ${ps.xAI.configured} — النموذج: ${XAI_MODEL}`);
    lines.push(`Gemini: ${ps.Gemini.configured ? ps.Gemini.models.join(" / ") : "غير مضبوط"}`);
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    await ctx.reply(`<b>فحص AI</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    await ctx.reply(`تعذر إكمال الفحص: ${escHtml(e.message)}`, { parse_mode: "HTML" });
  }
});

bot.command("setup", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  ctx.session.step = "awaiting_channel";
  await ctx.reply("أرسل معرف قناة/جروب السجل (مثال: @mychannel أو -1001556414386)\nأو أرسل /skip للتخطي.");
});

bot.command("settings", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  return ctx.reply("الإعدادات — اختر ما تريد تعديله:", mainMenuKeyboard());
});

bot.command("weather", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  const loading = await ctx.reply("جاري جلب حالة الطقس...");
  const report = await generateWeatherReport();
  await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
  if (report) await ctx.reply(report, { parse_mode: "HTML" });
  else await ctx.reply("تعذر جلب بيانات الطقس حالياً.");
});

bot.command("market", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  const loading = await ctx.reply("جاري جلب أسعار السوق...");
  const report = await generateMarketReport();
  await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
  if (report) await ctx.reply(report, { parse_mode: "HTML" });
  else await ctx.reply("تعذر جلب أسعار السوق حالياً.");
});

bot.command("save", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  const input = commandArg(ctx);
  if (!input) {
    return ctx.reply("اكتب تفاصيل التاجر بعد الأمر.\nمثال: /save التاجر أحمد – منظفات – المنصورة – 01000000000");
  }
  let loading;
  try {
    loading = await ctx.reply("جاري تحليل بيانات التجار...");
    const savedList = await saveMerchantFromText(input);
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    if (!savedList.length) return ctx.reply("لم يتم العثور على بيانات تجار صحيحة في النص.");
    const chunks = savedList.map((m) =>
      formatMerchant(m, m.isUpdated ? "تحديث\n" : "إضافة جديدة\n")
    );
    await ctx.reply(`تمت معالجة ${savedList.length} تاجر:\n\n${chunks.join("\n----------\n")}`, {
      parse_mode: "HTML",
    });
  } catch (err) {
    if (loading) await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    sendErrorAlert(err, "أمر /save");
    await ctx.reply("حدث خطأ أثناء حفظ بيانات التاجر. افحص حالة AI عبر /aitest.");
  }
});

bot.command("find", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  const keyword = commandArg(ctx);
  if (!keyword) return ctx.reply("اكتب كلمة البحث. مثال: /find المنصورة");
  let loading;
  try {
    loading = await ctx.reply("جاري البحث...");
    const results = await searchMerchants(keyword);
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    if (!results.length) return ctx.reply(`لا نتائج تطابق: ${keyword}`);
    const body = results.map((m) => formatMerchant(m)).join("\n----------\n");
    await ctx.reply(`نتائج (${escHtml(keyword)}):\n\n${body}`, { parse_mode: "HTML" });
  } catch (err) {
    if (loading) await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    sendErrorAlert(err, "أمر /find");
    await ctx.reply("حدث خطأ أثناء البحث.");
  }
});

bot.command("merchant", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  const merchantId = commandArg(ctx).split(/\s+/)[0];
  if (!/^\d+$/.test(merchantId)) return ctx.reply("اكتب رقم ID. مثال: /merchant 5");
  try {
    const res = await pool.query("SELECT * FROM merchants WHERE id = $1", [merchantId]);
    if (!res.rows.length) return ctx.reply(`لا تاجر برقم ${merchantId}`);
    await ctx.reply(formatMerchant(res.rows[0]), { parse_mode: "HTML" });
  } catch (err) {
    sendErrorAlert(err, "أمر /merchant");
    await ctx.reply("حدث خطأ أثناء البحث عن التاجر.");
  }
});

bot.command(["delete", "del"], async (ctx) => {
  if (!guardAdmin(ctx)) return;
  const merchantId = commandArg(ctx).split(/\s+/)[0];
  if (!/^\d+$/.test(merchantId)) return ctx.reply("اكتب رقم التاجر. مثال: /delete 5");
  try {
    const res = await pool.query("DELETE FROM merchants WHERE id = $1 RETURNING *", [merchantId]);
    if (!res.rows.length) return ctx.reply(`لا تاجر برقم ${merchantId}`);
    await ctx.reply(`تم الحذف:\n${formatMerchant(res.rows[0])}`, { parse_mode: "HTML" });
  } catch (err) {
    sendErrorAlert(err, "أمر /delete");
    await ctx.reply("حدث خطأ أثناء حذف التاجر.");
  }
});

bot.command("cleardb", async (ctx) => {
  if (!guardAdmin(ctx)) return;
  if (commandArg(ctx) !== "confirm") {
    return ctx.reply("هذا الأمر يمسح كل التجار. للتأكيد أرسل:\n/cleardb confirm");
  }
  try {
    await pool.query("TRUNCATE TABLE merchants RESTART IDENTITY");
    await ctx.reply("تم مسح جدول التجار وإعادة الترقيم من 1.");
  } catch (err) {
    sendErrorAlert(err, "أمر /cleardb");
    await ctx.reply("حدث خطأ أثناء مسح قاعدة البيانات.");
  }
});

async function cmdPrices(ctx) {
  if (!(await guardStaff(ctx))) return;
  const q = commandArg(ctx);
  try {
    const rows = await searchPrices(q, 25);
    await ctx.reply(formatSearchResults(rows, q), { parse_mode: "HTML" });
  } catch (err) {
    sendErrorAlert(err, "أمر أسعار");
    await ctx.reply("تعذر جلب الأسعار المرصودة.");
  }
}

async function cmdDigest(ctx) {
  if (!(await guardStaff(ctx))) return;
  try {
    const report = await formatDailyDigest();
    await ctx.reply(report || "لا توجد أسعار مرصودة اليوم بعد.", { parse_mode: "HTML" });
  } catch (err) {
    console.error("❌ /as3arday:", err?.stack || err);
    sendErrorAlert(err, "ملخص أسعار");
    await ctx.reply("تعذر تجهيز الملخص.");
  }
}

async function cmdDeals(ctx) {
  if (!(await guardStaff(ctx))) return;
  const loading = await ctx.reply("جاري البحث عن عروض حقيقية في أمازون ونون وجوميا وكارفور وكازيون...");
  try {
    const html = await fetchDealsReport();
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    await ctx.reply(html, { parse_mode: "HTML", disable_web_page_preview: true });
  } catch (err) {
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    sendErrorAlert(err, "عروض");
    await ctx.reply("تعذر جلب العروض الآن. تحقق من حالة مفاتيح الذكاء الاصطناعي من /aitest ثم أعد المحاولة.");
  }
}

bot.command(["as3ar", "prices"], cmdPrices);
bot.hears(/^\/أسعار(?:@\w+)?(?:\s|$)/, cmdPrices);
bot.command(["as3arday", "digest"], cmdDigest);
bot.hears(/^\/ملخص(?:@\w+)?(?:\s|$)/, cmdDigest);
bot.command(["orood", "deals"], cmdDeals);
bot.hears(/^\/عروض(?:@\w+)?(?:\s|$)/, cmdDeals);

bot.command("delprice", async (ctx) => {
  if (!(await guardStaff(ctx))) return;
  const id = commandArg(ctx).split(/\s+/)[0];
  if (!/^\d+$/.test(id)) return ctx.reply("اكتب رقم الرصد. مثال: /delprice 12");
  try {
    const ok = await deletePrice(id);
    await ctx.reply(ok ? `حُذف الرصد رقم ${id}.` : "لا يوجد رصد بهذا الرقم.");
  } catch (err) {
    sendErrorAlert(err, "حذف سعر");
    await ctx.reply("تعذر حذف الرصد.");
  }
});

bot.action("noop", (ctx) => safeCb(ctx));
bot.action("main_page1", async (ctx) => {
  await safeCb(ctx);
  await safeEdit(ctx, "الإعدادات — اختر ما تريد تعديله:", mainMenuKeyboard());
});
bot.action("main_page2", async (ctx) => {
  await safeCb(ctx);
  await safeEdit(ctx, "المزيد من الإعدادات:", page2MenuKeyboard());
});
bot.action("close_menu", async (ctx) => {
  await safeCb(ctx);
  await ctx.deleteMessage().catch(() => {});
});
bot.action("sub_antispam", async (ctx) => {
  await safeCb(ctx);
  await safeEdit(ctx, "إعدادات مانع الرسائل المزعجة:", antiSpamKeyboard());
});
bot.action("sub_antirepeat", async (ctx) => {
  await safeCb(ctx);
  await safeEdit(ctx, "حد التكرار (عدد الرسائل المتشابهة قبل العقوبة):", antiRepeatKeyboard());
});
bot.action("sub_warnings", async (ctx) => {
  await safeCb(ctx);
  await safeEdit(ctx, "إعدادات نظام الإنذارات:", warningsKeyboard());
});
bot.action("sub_penalties", async (ctx) => {
  await safeCb(ctx);
  await safeEdit(ctx, "إعدادات عقوبات المخالفات:", penaltyKeyboard());
});
bot.action("sub_links", async (ctx) => {
  await safeCb(ctx);
  await safeEdit(ctx, "إعدادات الروابط المسموحة:", allowedLinksKeyboard());
});
bot.action("sub_welcome", async (ctx) => {
  await safeCb(ctx);
  await safeEdit(ctx, "إعدادات رسالة الترحيب:", welcomeKeyboard());
});
bot.action("sub_farewell", async (ctx) => {
  await safeCb(ctx);
  await safeEdit(ctx, "إعدادات رسالة الوداع:", farewellKeyboard());
});
bot.action("sub_inactive", async (ctx) => {
  await safeCb(ctx);
  await safeEdit(ctx, "متابعة الأعضاء الخاملين:", inactiveKeyboard());
});
bot.action("sub_scheduled", async (ctx) => {
  await safeCb(ctx);
  await safeEdit(ctx, "الرسائل المجدولة (توقيت القاهرة):", scheduledKeyboard());
});
bot.action("sub_logchannel", async (ctx) => {
  await safeCb(ctx);
  const current = logChannelId || process.env.LOG_CHANNEL_ID || "غير محددة";
  await ctx.reply(`معرف قناة السجل الحالي: ${current}\nلتغييره أرسل /setup`);
});

function toggleSetting(key) {
  return async (ctx) => {
    settings[key] = !settings[key];
    saveAllSettings();
    await safeCb(ctx, settings[key] ? "تم التفعيل" : "تم التعطيل");
  };
}

bot.action("toggle_link", async (ctx) => {
  await toggleSetting("antiLink")(ctx);
  await safeEdit(ctx, "المزيد من الإعدادات:", page2MenuKeyboard());
});
bot.action("toggle_porn", async (ctx) => {
  await toggleSetting("antiPorn")(ctx);
  await safeEdit(ctx, "المزيد من الإعدادات:", page2MenuKeyboard());
});
bot.action("toggle_log", async (ctx) => {
  await toggleSetting("logActions")(ctx);
  await safeEdit(ctx, "المزيد من الإعدادات:", page2MenuKeyboard());
});
bot.action("toggle_badwords", async (ctx) => {
  await toggleSetting("antiBadWords")(ctx);
  await safeEdit(ctx, "المزيد من الإعدادات:", page2MenuKeyboard());
});
bot.action("toggle_autojoin", async (ctx) => {
  await toggleSetting("autoApproveJoin")(ctx);
  await safeEdit(ctx, "المزيد من الإعدادات:", page2MenuKeyboard());
});
bot.action("toggle_service", async (ctx) => {
  await toggleSetting("deleteServiceMessages")(ctx);
  await safeEdit(ctx, "المزيد من الإعدادات:", page2MenuKeyboard());
});
bot.action("toggle_antispam", async (ctx) => {
  await toggleSetting("antiSpam")(ctx);
  await safeEdit(ctx, "إعدادات مانع الرسائل المزعجة:", antiSpamKeyboard());
});
bot.action("toggle_antiforward", async (ctx) => {
  await toggleSetting("antiForward")(ctx);
  await safeEdit(ctx, "إعدادات مانع الرسائل المزعجة:", antiSpamKeyboard());
});
bot.action("toggle_welcome", async (ctx) => {
  await toggleSetting("welcome")(ctx);
  await safeEdit(ctx, "إعدادات رسالة الترحيب:", welcomeKeyboard());
});
bot.action("toggle_farewell", async (ctx) => {
  await toggleSetting("farewell")(ctx);
  await safeEdit(ctx, "إعدادات رسالة الوداع:", farewellKeyboard());
});
bot.action("toggle_autoprice", async (ctx) => {
  await toggleSetting("autoPrice")(ctx);
  await safeEdit(ctx, "الإعدادات — اختر ما تريد تعديله:", mainMenuKeyboard());
});
bot.action("toggle_penalty_type", async (ctx) => {
  settings.penaltyType = settings.penaltyType === "mute" ? "ban" : "mute";
  saveAllSettings();
  await safeCb(ctx, `العقوبة: ${settings.penaltyType === "mute" ? "كتم" : "حظر"}`);
  await safeEdit(ctx, "إعدادات عقوبات المخالفات:", penaltyKeyboard());
});
bot.action(/set_dur_(\d+)/, async (ctx) => {
  settings.penaltyDuration = parseInt(ctx.match[1], 10);
  saveAllSettings();
  await safeCb(ctx, "تم تحديد المدة");
  await safeEdit(ctx, "إعدادات عقوبات المخالفات:", penaltyKeyboard());
});
bot.action(/set_warn_max_(\d+)/, async (ctx) => {
  settings.warnMax = parseInt(ctx.match[1], 10);
  saveAllSettings();
  await safeCb(ctx, `الإنذارات: ${settings.warnMax}`);
  await safeEdit(ctx, "إعدادات نظام الإنذارات:", warningsKeyboard());
});
bot.action("set_warn_act_kick", async (ctx) => {
  settings.warnAction = "kick";
  saveAllSettings();
  await safeCb(ctx, "طرد");
  await safeEdit(ctx, "إعدادات نظام الإنذارات:", warningsKeyboard());
});
bot.action("set_warn_act_mute", async (ctx) => {
  settings.warnAction = "mute";
  saveAllSettings();
  await safeCb(ctx, "كتم");
  await safeEdit(ctx, "إعدادات نظام الإنذارات:", warningsKeyboard());
});
bot.action("set_warn_act_ban", async (ctx) => {
  settings.warnAction = "ban";
  saveAllSettings();
  await safeCb(ctx, "حظر");
  await safeEdit(ctx, "إعدادات نظام الإنذارات:", warningsKeyboard());
});
bot.action("set_warn_act_none", async (ctx) => {
  settings.warnAction = "none";
  saveAllSettings();
  await safeCb(ctx, "بلا عقوبة");
  await safeEdit(ctx, "إعدادات نظام الإنذارات:", warningsKeyboard());
});
bot.action(/set_repeat_(\d+)/, async (ctx) => {
  settings.maxFloodMsgs = parseInt(ctx.match[1], 10);
  saveAllSettings();
  await safeCb(ctx, `حد التكرار: ${settings.maxFloodMsgs}`);
  await safeEdit(ctx, "حد التكرار (عدد الرسائل المتشابهة قبل العقوبة):", antiRepeatKeyboard());
});
bot.action("view_allowed_links", async (ctx) => {
  await safeCb(ctx);
  const allowed = loadAllowed();
  const msg = allowed.map((link, i) => `${i + 1}. <code>${escHtml(link)}</code>`).join("\n");
  await ctx.reply(`الروابط المسموحة:\n\n${msg}`, { parse_mode: "HTML" });
});
bot.action("add_allowed_link", async (ctx) => {
  await safeCb(ctx);
  ctx.session.step = "awaiting_link";
  await ctx.reply("أرسل الرابط (مثال: example.com)");
});
bot.action("clear_allowed_links", async (ctx) => {
  saveAllowed(DEFAULT_ALLOWED_LINKS.slice());
  await safeCb(ctx, "أُعيد الضبط");
});
bot.action("set_photos_limit", async (ctx) => {
  settings.maxPhotos = settings.maxPhotos >= 10 ? 1 : settings.maxPhotos + 1;
  saveAllSettings();
  await safeCb(ctx, `حد الصور: ${settings.maxPhotos}`);
  await safeEdit(ctx, "إعدادات مانع الرسائل المزعجة:", antiSpamKeyboard());
});
bot.action("set_videos_limit", async (ctx) => {
  settings.maxVideos = settings.maxVideos >= 10 ? 1 : settings.maxVideos + 1;
  saveAllSettings();
  await safeCb(ctx, `حد الفيديو: ${settings.maxVideos}`);
  await safeEdit(ctx, "إعدادات مانع الرسائل المزعجة:", antiSpamKeyboard());
});
bot.action("set_admin_handle", async (ctx) => {
  await safeCb(ctx);
  ctx.session.step = "awaiting_admin_handle";
  await ctx.reply("أرسل المعرف الجديد (مثال: @username)");
});
bot.action("check_inactive_count", async (ctx) => {
  await safeCb(ctx);
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  let count = 0;
  userActivity.forEach((v) => {
    if (now - lastActiveTs(v) > thirtyDays) count += 1;
  });
  await ctx.reply(`عدد الخاملين لأكثر من 30 يوماً (من المتتبَّعين): ${count}`);
});
bot.action("send_inactive_pm", async (ctx) => {
  await safeCb(ctx);
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const targets = [];
  userActivity.forEach((v, k) => {
    if (now - lastActiveTs(v) > thirtyDays) targets.push(k);
  });
  if (!targets.length) return ctx.reply("لا يوجد خاملون لإرسال تنبيه لهم.");
  await ctx.reply(`جاري إرسال تنبيه إلى ${targets.length} عضو... قد يستغرق ذلك دقيقة.`);
  const contact = settings.adminContact || DEFAULT_ADMIN_CONTACT;
  const body =
    `مرحباً، لاحظنا غياب مشاركتك في مجموعة بورصة المنظفات لأكثر من 30 يوماً. ` +
    `المجموعة قائمة على التفاعل المتبادل. إن كنت ما زلت مهتماً شارك معنا الأسعار أو سؤالاً. ` +
    `للتواصل: ${contact}`;
  let ok = 0;
  let fail = 0;
  for (const id of targets) {
    try {
      await bot.telegram.sendMessage(id, body);
      ok += 1;
    } catch {
      fail += 1;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await ctx.reply(`تم. وصل: ${ok} — تعذر (لم يبدأوا البوت): ${fail}`);
});
bot.action("add_scheduled_post", async (ctx) => {
  await safeCb(ctx);
  ctx.session.step = "awaiting_scheduled_post";
  ctx.session.draft = {};
  await ctx.reply("أرسل نص الرسالة المجدولة.");
});
bot.action("list_scheduled_posts", async (ctx) => {
  await safeCb(ctx);
  if (!scheduledPosts.length) return ctx.reply("لا توجد رسائل مجدولة.");
  const msg = scheduledPosts
    .map((p, i) => `${i + 1}. [${p.time || "بدون وقت"}] ${p.text}`)
    .join("\n\n");
  await ctx.reply(msg.slice(0, 3500));
});
bot.action("clear_scheduled_posts", async (ctx) => {
  scheduledPosts = [];
  saveAllSettings();
  await safeCb(ctx, "تم المسح");
});

bot.action(/undo_penalty_(mute|ban)_(\d+)/, async (ctx) => {
  const type = ctx.match[1];
  const targetId = Number(ctx.match[2]);
  try {
    if (type === "mute") {
      await ctx.telegram.restrictChatMember(ctx.chat.id, targetId, {
        permissions: MUTE_PERMISSIONS_ON,
      });
    } else {
      await ctx.telegram.unbanChatMember(ctx.chat.id, targetId, { only_if_banned: true });
    }
    resetUserTrackers(targetId);
    await safeCb(ctx, "أُلغيت العقوبة");
    await safeEdit(ctx, `أُلغيت العقوبة بواسطة ${ctx.from.first_name}`);
  } catch (e) {
    sendErrorAlert(e, `إلغاء عقوبة ${type}`);
    await ctx.answerCbQuery("تعذر إلغاء العقوبة.", { show_alert: true }).catch(() => {});
  }
});

bot.on("text", async (ctx, next) => {
  if (!ctx.session?.step) return next();
  if (!guardAdmin(ctx)) return next();
  if (ctx.chat?.type !== "private") return next();
  const text = ctx.message.text.trim();

  if (ctx.session.step === "awaiting_channel") {
    if (text !== "/skip") {
      logChannelId = formatChatId(text) || text;
      saveAllSettings();
      await ctx.reply(`تم تعيين الهدف: ${logChannelId}`);
    } else {
      await ctx.reply("تم تخطي إعداد القناة.");
    }
    ctx.session.step = null;
    return;
  }
  if (ctx.session.step === "awaiting_link") {
    const current = loadAllowed().slice();
    current.push(text);
    saveAllowed(current);
    await ctx.reply(`أُضيف: ${text}`);
    ctx.session.step = null;
    return;
  }
  if (ctx.session.step === "awaiting_admin_handle") {
    settings.adminContact = text;
    saveAllSettings();
    await ctx.reply(`حساب الإدارة: ${settings.adminContact}`);
    ctx.session.step = null;
    return;
  }
  if (ctx.session.step === "awaiting_scheduled_post") {
    ctx.session.draft = { text };
    ctx.session.step = "awaiting_scheduled_time";
    await ctx.reply("أرسل الوقت يومياً بتوقيت القاهرة بصيغة HH:MM (مثال: 09:30)");
    return;
  }
  if (ctx.session.step === "awaiting_scheduled_time") {
    if (!/^\d{1,2}:\d{2}$/.test(text)) {
      return ctx.reply("صيغة الوقت غير صحيحة. مثال: 09:30");
    }
    const [h, m] = text.split(":");
    const time = `${String(h).padStart(2, "0")}:${m}`;
    scheduledPosts.push({
      text: ctx.session.draft.text,
      time,
      chatId: logChannelId || process.env.LOG_CHANNEL_ID || null,
      createdAt: Date.now(),
      lastSent: null,
    });
    saveAllSettings();
    ctx.session.step = null;
    ctx.session.draft = {};
    await ctx.reply(`حُفظت الرسالة لتُرسل يومياً الساعة ${time} بتوقيت القاهرة.`);
    return;
  }
  return next();
});

const app = express();
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_URL = (process.env.WEBHOOK_URL || "").replace(/\/$/, "");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    version: APP_VERSION,
    uptime: process.uptime(),
    ts: Date.now(),
    db: Boolean(pool),
    ai: { xaiKeys: providerStatus().xAI.configured, gemini: providerStatus().Gemini.configured },
  });
});
app.get("/", (_req, res) => {
  res.status(200).send("Borsa detergents bot is running.");
});

if (WEBHOOK_URL) {
  app.use(express.json());
  app.use(
    bot.webhookCallback("/webhook", WEBHOOK_SECRET ? { secretToken: WEBHOOK_SECRET } : {})
  );
}

let server;

async function registerCommands() {
  try {
    await bot.telegram.setMyCommands([], { scope: { type: "default" } });
    await bot.telegram.setMyCommands(ADMIN_COMMANDS, {
      scope: { type: "all_chat_administrators" },
    });
    for (const id of AUTHORIZED_IDS) {
      try {
        await bot.telegram.setMyCommands(ADMIN_COMMANDS, {
          scope: { type: "chat", chat_id: Number(id) },
        });
      } catch (e) {
        console.warn("setMyCommands chat", id, e.message);
      }
    }
    console.log("✅ قائمة الأوامر جاهزة.");
  } catch (err) {
    console.error("❌ أوامر البوت:", err.message);
  }
}

async function start() {
  await initStorage();
  startSchedulers();

  server = app.listen(PORT, "0.0.0.0", async () => {
    console.log(`🚀 الخادم على المنفذ ${PORT} — build ${APP_VERSION}`);
    console.log("⏰ توقيت القاهرة:", new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }));
    const aiState = providerStatus();
    console.log(`🤖 AI: OpenAI=${aiState.OpenAI.configured} (${OPENAI_MODEL}) | xAI=${aiState.xAI.configured} (grok-4.7) | Gemini=${aiState.Gemini.configured ? aiState.Gemini.models.join(",") : "غير مضبوط"}`);

    if (WEBHOOK_URL) {
      try {
        await bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`, {
          secret_token: WEBHOOK_SECRET || undefined,
          allowed_updates: ALLOWED_UPDATES,
          drop_pending_updates: true,
        });
        console.log(`✅ Webhook: ${WEBHOOK_URL}/webhook`);
      } catch (err) {
        console.error("❌ إعداد Webhook:", err.message);
        sendErrorAlert(err, "إعداد Webhook");
      }
    } else {
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      } catch {
        /* لا يوجد webhook سابق */
      }
      bot
        .launch({ allowedUpdates: ALLOWED_UPDATES, dropPendingUpdates: true })
        .then(() => console.log("⚡ Polling يعمل (Termux / بدون WEBHOOK_URL)."))
        .catch((err) => {
          console.error("❌ Polling:", err.message);
          sendErrorAlert(err, "Polling");
        });
    }

    await registerCommands();
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`⏹ ${signal} — إيقاف آمن...`);
  try {
    saveActivity();
    saveWarnings();
    await persistAll();
  } catch {
    /* */
  }
  try {
    bot.stop(signal);
  } catch {
    /* */
  }
  try {
    if (pool) await pool.end();
  } catch {
    /* */
  }
  if (server) {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000);
  } else {
    process.exit(0);
  }
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

start().catch((err) => {
  console.error("فشل التشغيل:", err);
  process.exit(1);
});
