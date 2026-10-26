"use strict";
require("dotenv").config();

const { Telegraf } = require("telegraf");
const { createWebhookServer, getWebhookConfig } = require("./core/webhook");
const { createAI } = require("./core/ai");
const db = require("./core/database");
const { runMigrations } = require("./core/migrations");
const { loadRegistry } = require("./core/product-registry");
const { claimMessage, isBotMessage, isLogChat } = require("./core/message-gate");
const { cacheMessage, getMessageByRef } = require("./core/message-cache");
const { log, makeReport, emitReport, redactString } = require("./core/diagnostics");
const { buildChemicalLinks, renderChemicalLinks } = require("./core/links");
const { formatTelegramStartupError } = require("./core/telegram-startup-error");
const { installFatalProcessHandlers } = require("./core/fatal-process");
const { send: logChannel, LOG_CHAT_ID } = require("./core/log-channel");
const { MASTER_ID, canManage, isMaster, authorizedUserIds } = require("./core/permissions");
const { approvePendingGroup } = require("./core/group-approval");
const { isListLike, deterministicList, extractList } = require("./modules/price-list");
const { renderPriceListImages } = require("./modules/price-list-image");
const priceMonitor = require("./modules/price-monitor");
const priceReview = require("./modules/price-review");
const { saveMerchant } = require("./modules/merchant-intelligence");
const chemical = require("./modules/chemical-assistant");
const deals = require("./modules/deals");
const protection = require("./modules/protection");
const scheduler = require("./modules/scheduler");
const { parseLocalDateTime } = require("./core/cairo-time");
const weather = require("./modules/weather");
const { ensureWeatherSchedulerSchema, startWeatherScheduler } = require("./modules/weather-scheduler");
const { startDealScheduler } = require("./modules/deal-scheduler");
const legacyAdmin = require("./modules/legacy-admin");
const adminPanel = require("./modules/admin-panel");
const { fetchSearch } = require("./modules/deal-sources");
const { startCatalogNewsletterScheduler } = require("./modules/catalog-newsletter-scheduler");
const { ensureEconomicNewsletterSchema, startEconomicNewsletterScheduler } = require("./modules/economic-newsletter");

const APP_VERSION = require("./package.json").version;
const BOT_CREDIT = "مدعوم بتقنيات ChatGPT";
const registry = loadRegistry();

if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN غير مضبوط. هذا البناء لا يبدأ دون توكن.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL غير مضبوط. تم إيقاف التشغيل الآمن حتى لا يعمل البوت بلا سجل دائم أو حماية تفويض المجموعات.");
  process.exit(1);
}

let webhookConfig;
try {
  webhookConfig = getWebhookConfig(process.env);
} catch (error) {
  console.error(`[WEBHOOK_CONFIG_INVALID] ${error.message}`);
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 30000 });
const ai = createAI();
const chemicalAI = createAI({ provider: "gemini", fallbackProviders: ["openai", "groq"] });
let botUserId = null;
let stopScheduledMessages = () => {};
let stopDeals = () => {};
let stopCatalogs = () => {};
let stopWeather = () => {};
let stopEconomicNewsletter = () => {};
let shutdownPromise = null;
let shutdownRequested = false;
let startupPhase = true;
let webhookServer = null;

function messageData(ctx) {
  const m = ctx.message || ctx.editedMessage || ctx.channelPost || ctx.callbackQuery?.message;
  return {
    chatId: m?.chat?.id,
    chatType: m?.chat?.type,
    messageId: m?.message_id,
    userId: ctx.callbackQuery?.from?.id || m?.from?.id,
    text: m?.text || "",
    caption: m?.caption || "",
    messageType: m?.photo ? "photo" : m?.video ? "video" : m?.document ? "document" : "text",
  };
}

function commandText(text) { return String(text || "").replace(/^\/[^\s@]+(?:@[^\s]+)?\s*/i, "").trim(); }
function commandName(text) { return String(text || "").match(/^\/([^\s@]+)/)?.[1] || ""; }

function parseMessageLink(value) {
  const s = String(value || "").trim();
  const m = s.match(/^https?:\/\/(?:t\.me|telegram\.me)\/(?:c\/(\d+)\/(\d+)|([A-Za-z0-9_]+)\/(\d+))$/i);
  if (!m) return null;
  if (m[1] && m[2]) return { chatId: Number(`-100${m[1]}`), messageId: Number(m[2]) };
  return { username: `@${m[3]}`, messageId: Number(m[4]) };
}

const recentLogAlerts = new Map();
async function sendLog(event) {
  const stage = String(event?.stage || "event");
  const dedupeStages = new Set(["message_flagged", "rate_limit_detected", "media_quota_detected"]);
  if (dedupeStages.has(stage)) {
    const details = event?.details || {};
    const discriminator = stage === "message_flagged"
      ? [...(details.reasons || [])].sort().join(",")
      : stage === "media_quota_detected" ? String(details.type || "media") : "rate_limit";
    const key = `${event?.module || "bot"}|${stage}|${event?.status || "unknown"}|${discriminator}`;
    const now = Date.now();
    const last = recentLogAlerts.get(key) || 0;
    if (now - last < 10 * 60_000) return false;
    recentLogAlerts.set(key, now);
    if (recentLogAlerts.size > 2000) {
      for (const [k, ts] of recentLogAlerts) if (now - ts > 60 * 60_000) recentLogAlerts.delete(k);
      while (recentLogAlerts.size > 2000) recentLogAlerts.delete(recentLogAlerts.keys().next().value);
    }
  }
  await logChannel(bot, event);
  return true;
}

async function authorizeChat(chatId, chatType, ownerUserId, authorizedBy = ownerUserId) {
  if (!db.pool) return false;
  await db.query(`INSERT INTO authorized_chats(chat_id,chat_type,owner_user_id,authorized_by)
    VALUES($1,$2,$3,$4) ON CONFLICT(chat_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id, authorized_by=EXCLUDED.authorized_by, active=TRUE`,
    [chatId, chatType, ownerUserId ?? null, authorizedBy ?? null]);
  return true;
}

async function isAuthorizedChat(chatId) {
  if (!db.pool) return false;
  const r = await db.query(`SELECT active FROM authorized_chats WHERE chat_id=$1`, [chatId]);
  return Boolean(r.rows[0]?.active);
}

async function isPrivateController(userId) {
  if (isMaster(userId)) return true;
  if (!db.pool || !userId) return false;
  const r = await db.query(`SELECT 1 FROM authorized_chats WHERE active=TRUE AND chat_type IN ('group','supergroup') AND owner_user_id=$1 LIMIT 1`, [userId]);
  return Boolean(r.rowCount);
}

async function canControl(ctx, m = messageData(ctx)) {
  if (isMaster(m.userId)) return true;
  if (m.chatType === "private") return isPrivateController(m.userId);
  return canManage(ctx.telegram, m.chatId, m.userId);
}

async function showPrivatePanel(ctx, edit = false) {
  if (ctx.chat?.type !== "private" || !(await isPrivateController(ctx.from?.id))) {
    if (ctx.callbackQuery && ctx.answerCbQuery) await ctx.answerCbQuery("هذه اللوحة خاصة بالمالك فقط.", { show_alert: true }).catch(() => {});
    return false;
  }
  const text = adminPanel.panelText(APP_VERSION, ai.providers || []);
  const extra = { reply_markup: adminPanel.privatePanelKeyboard(), disable_web_page_preview: true };
  if (ctx.callbackQuery && ctx.answerCbQuery) await ctx.answerCbQuery().catch(() => {});
  if (edit && ctx.editMessageText) {
    try { await ctx.editMessageText(text, extra); return true; } catch {}
  }
  await ctx.reply(text, extra);
  return true;
}

async function configureCommandMenus() {
  const privateAdminCommands = [
    { command: "panel", description: "لوحة التحكم الخاصة" },
    { command: "approvechat", description: "اعتماد مجموعة (مالك البوت فقط)" }
  ];
  const groupOwnerCommands = [
    { command: "pricelist", description: "اعتماد ونشر قائمة أسعار شركة" },
    { command: "claim", description: "طلب اعتماد المجموعة" },
    { command: "settings", description: "إعدادات المجموعة" },
    { command: "antispam", description: "إعدادات مانع الإزعاج" },
    { command: "schedule", description: "جدولة رسالة" },
    { command: "warn", description: "تسجيل إنذار" },
    { command: "warnings", description: "عرض الإنذارات" },
    { command: "clearwarn", description: "إغلاق الإنذارات" },
    { command: "inactive", description: "تقرير الأعضاء الخاملين" }
  ];
  const groupCommands = [
    { command: "chemical", description: "المساعد الكيميائي" }
  ];

  // Keep management commands out of the shared group menu. Telegram supports
  // per-member command scopes, so only each group's creator and configured bot
  // owners receive the management menu inside that group.
  await bot.telegram.setMyCommands([], { scope: { type: "default" } });
  await bot.telegram.setMyCommands(groupCommands, { scope: { type: "all_group_chats" } });

  const botOwnerIds = new Set([...authorizedUserIds()].map(String));
  const privateOwnerIds = new Set(botOwnerIds);
  const groupOwners = [];
  try {
    const activeGroups = await db.query(`SELECT chat_id, owner_user_id FROM authorized_chats
      WHERE active=TRUE AND chat_type IN ('group','supergroup') AND owner_user_id IS NOT NULL`);
    const pendingGroups = await db.query(`SELECT chat_id, owner_user_id FROM pending_group_approvals
      WHERE status='pending' AND chat_type IN ('group','supergroup') AND owner_user_id IS NOT NULL`);
    for (const row of activeGroups.rows) {
      const chatId = Number(row.chat_id);
      const ownerId = String(row.owner_user_id);
      if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(Number(ownerId))) continue;
      groupOwners.push({ chatId, ownerId });
      privateOwnerIds.add(ownerId);
    }
    for (const row of pendingGroups.rows) {
      const chatId = Number(row.chat_id);
      const ownerId = String(row.owner_user_id);
      if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(Number(ownerId))) continue;
      groupOwners.push({ chatId, ownerId });
    }
    for (const { chatId, ownerId } of groupOwners) {
      try {
        await bot.telegram.setMyCommands(groupOwnerCommands, {
          scope: { type: "chat_member", chat_id: chatId, user_id: Number(ownerId) }
        });
      } catch (error) {
        await sendLog({ module: "security", stage: "command_menu_group_owner_scope", severity: "warn", status: "failed", details: { chatId, ownerId: Number(ownerId), code: error.code || null, message: error.message } });
      }
      for (const id of botOwnerIds) {
        const userId = Number(id);
        if (!Number.isSafeInteger(userId) || id === ownerId) continue;
        try {
          await bot.telegram.setMyCommands(groupOwnerCommands, {
            scope: { type: "chat_member", chat_id: chatId, user_id: userId }
          });
        } catch (error) {
          await sendLog({ module: "security", stage: "command_menu_bot_owner_group_scope", severity: "warn", status: "failed", details: { chatId, ownerId: userId, code: error.code || null, message: error.message } });
        }
      }
    }
  } catch (error) {
    await sendLog({ module: "security", stage: "command_menu_owner_lookup", severity: "warn", status: "partial", details: { code: error.code || null } });
  }

  // Private controller commands are scoped to known bot owners and verified
  // group creators. Authorization is still enforced by each command handler.
  for (const id of privateOwnerIds) {
    const userId = Number(id);
    if (!Number.isSafeInteger(userId)) continue;
    const commands = botOwnerIds.has(id)
      ? [...privateAdminCommands, ...groupOwnerCommands.filter(command => command.command !== "claim")]
      : [{ command: "panel", description: "لوحة التحكم الخاصة" }, ...groupOwnerCommands.filter(command => command.command !== "claim")];
    try {
      await bot.telegram.setMyCommands(commands, { scope: { type: "chat", chat_id: userId } });
    } catch (error) {
      await sendLog({ module: "security", stage: "command_menu_private_scope", severity: "warn", status: "failed", details: { ownerId: userId, code: error.code || null, message: error.message } });
    }
  }
}

async function ensureDb() {
  if (!db.pool) throw new Error("DATABASE_URL غير مضبوط؛ لا يمكن تطبيق ترحيلات قاعدة البيانات بأمان");
  return runMigrations({ db, rootDir: __dirname });
}

bot.use(async (ctx, next) => {
  const m = messageData(ctx);
  if (!m.chatId || isLogChat(m.chatId)) return;
  const isMessageUpdate = Boolean(ctx.message || ctx.editedMessage || ctx.channelPost);
  if (isMessageUpdate && m.messageId) await cacheMessage(db.pool, m).catch(e => console.warn("[CACHE_FAIL]", redactString(e?.message || "cache_error")));
  if (isMessageUpdate && m.messageId && !(await claimMessage(db.pool, { chatId: m.chatId, messageId: m.messageId, updateType: ctx.updateType }))) return;
  if (["group", "supergroup"].includes(m.chatType) && m.userId && !isBotMessage(ctx, botUserId)) {
    legacyAdmin.recordActivity(db.pool, { chatId: m.chatId, userId: m.userId, username: ctx.from?.username, displayName: [ctx.from?.first_name,ctx.from?.last_name].filter(Boolean).join(" ") }).catch(e => console.warn("[ACTIVITY_TRACK_FAIL]", redactString(e?.message || "activity_track_error")));
  }
  // Legacy protection is additive and audit-first. Destructive enforcement is opt-in.
  if (["group", "supergroup"].includes(m.chatType) && (m.text || m.caption) && !/^\s*\//.test(m.text || "") && !isBotMessage(ctx, botUserId)) {
    try {
      let opts = { anti_spam_enabled: true, block_excessive_links: true, max_links: 5, max_message_length: 5000, block_untrusted_forwards: false };
      const setting = await db.query("SELECT * FROM moderation_settings WHERE chat_id=$1", [m.chatId]).catch(() => ({ rows: [] }));
      if (setting.rows[0]) opts = { ...opts, ...setting.rows[0] };
      if (opts.anti_spam_enabled) {
        const rateInput = { chatId: m.chatId, userId: m.userId, messageId: m.messageId, limit: Number(process.env.PROTECTION_RATE_LIMIT || 5), windowMs: Number(process.env.PROTECTION_RATE_WINDOW_MS || 60_000) };
        const rate = db.pool && m.messageId != null
          ? await protection.recordRate(db.pool, rateInput)
          : protection.inspectRate(rateInput);
        if (rate.limited) {
          await db.query("INSERT INTO moderation_events(chat_id,message_id,user_id,action,reason,details) VALUES($1,$2,$3,$4,$5,$6)", [m.chatId, m.messageId || null, m.userId || null, "flagged", "rate_limit", JSON.stringify({ count: rate.count, limit: rate.limit, windowMs: rate.windowMs })]).catch(() => {});
          await sendLog({ module: "protection", stage: "rate_limit_detected", severity: "warn", status: "audit_only", details: { chatId: m.chatId, messageId: m.messageId, userId: m.userId, count: rate.count, limit: rate.limit, windowMs: rate.windowMs } });
        }
        const mediaMessage = ctx.message || ctx.editedMessage || ctx.channelPost;
        const messageType = mediaMessage?.photo ? "photo" : mediaMessage?.video ? "video" : mediaMessage?.document ? "document" : "text";
        const mediaQuotaInput = {
          chatId: m.chatId, userId: m.userId, messageType,
          messageId: m.messageId,
          now: Date.now(),
          photoLimit: Number(process.env.PROTECTION_DAILY_PHOTO_LIMIT || 3),
          videoLimit: Number(process.env.PROTECTION_DAILY_VIDEO_LIMIT || 1),
          mediaGroupId: mediaMessage?.media_group_id || null
        };
        // Use PostgreSQL counters when available so restarts and multiple replicas
        // share the same audit count. The process-local fallback remains audit-only.
        const mediaQuota = db.pool
          ? await protection.recordMediaQuota(db.pool, mediaQuotaInput)
          : protection.inspectMediaQuota(mediaQuotaInput);
        if (mediaQuota.exceeded) {
          await db.query("INSERT INTO moderation_events(chat_id,message_id,user_id,action,reason,details) VALUES($1,$2,$3,$4,$5,$6)", [m.chatId, m.messageId || null, m.userId || null, "flagged", "daily_media_quota", JSON.stringify({ type: messageType, count: mediaQuota.count, limit: mediaQuota.limit, day: mediaQuota.day, mediaGroupId: mediaQuota.mediaGroupId })]).catch(() => {});
          await sendLog({ module: "protection", stage: "media_quota_detected", severity: "warn", status: "audit_only", details: { chatId: m.chatId, messageId: m.messageId, userId: m.userId, type: messageType, count: mediaQuota.count, limit: mediaQuota.limit, day: mediaQuota.day, mediaGroupId: mediaQuota.mediaGroupId } });
        }
        const result = protection.inspectMessage({ text: m.text, caption: m.caption, messageType, isForward: Boolean(mediaMessage?.forward_origin || mediaMessage?.forward_from || mediaMessage?.forward_from_chat), trustedForward: false }, { maxLinks: opts.block_excessive_links ? opts.max_links : 999, maxLength: opts.max_message_length, blockUntrustedForwards: opts.block_untrusted_forwards });
        if (!result.allowed) {
          await db.query("INSERT INTO moderation_events(chat_id,message_id,user_id,action,reason,details) VALUES($1,$2,$3,$4,$5,$6)", [m.chatId, m.messageId || null, m.userId || null, process.env.PROTECTION_ENFORCE === "true" ? "delete_attempt" : "flagged", result.reasons.join(","), JSON.stringify({ length: result.length, linkCount: result.linkCount })]).catch(() => {});
          await sendLog({ module: "protection", stage: "message_flagged", severity: "warn", status: process.env.PROTECTION_ENFORCE === "true" ? "delete_attempted" : "audit_only", details: { chatId: m.chatId, messageId: m.messageId, userId: m.userId, reasons: result.reasons } });
          if (process.env.PROTECTION_ENFORCE === "true" && m.messageId) {
            try { await ctx.telegram.deleteMessage(m.chatId, m.messageId); } catch (e) { await sendLog({ module: "protection", stage: "delete_message", severity: "error", status: "failed", details: { code: e.code, message: e.message } }); }
            return;
          }
        }
      }
    } catch (error) {
      const report = makeReport({ module: "protection", stage: "middleware", severity: "ERROR", action: "inspect_message", error, input: m.text, chatId: m.chatId, messageId: m.messageId });
      await emitReport({ bot, db, report });
    }
  }
  return next();
});

bot.on("my_chat_member", async ctx => {
  const u = ctx.myChatMember;
  const chat = u?.chat;
  const nextStatus = u?.new_chat_member?.status;
  // Group authorization is intentionally limited to groups and supergroups; channels are out of scope.
  if (!chat || !["group", "supergroup"].includes(chat.type) || !["member", "administrator"].includes(nextStatus)) return;
  const actor = u?.from?.id;
  let creatorId = null;
  if (chat.type !== "channel") {
    try {
      const admins = await ctx.telegram.getChatAdministrators(chat.id);
      creatorId = admins.find(a => a.status === "creator")?.user?.id || null;
    } catch { creatorId = null; }
  }
  // Adding the bot never grants authorization, including when the actor is the fixed bot master.
  // Keep existing active approvals intact; every unapproved group must go through /claim and /approvechat.
  if (db.pool) {
    const existing = await db.query(
      "SELECT active FROM authorized_chats WHERE chat_id=$1",
      [chat.id]
    );
    if (existing.rows[0]?.active === true) {
      await sendLog({ module: "security", stage: "authorized_group_bot_readded", status: "preserved", details: { chatId: chat.id, actor, ownerUserId: creatorId, chatType: chat.type } });
      return;
    }
    await db.query("UPDATE authorized_chats SET active=FALSE WHERE chat_id=$1", [chat.id]);
    await db.query(`INSERT INTO pending_group_approvals(chat_id,chat_type,requested_by,owner_user_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(chat_id) DO UPDATE SET
      chat_type=EXCLUDED.chat_type, requested_by=EXCLUDED.requested_by,
      owner_user_id=EXCLUDED.owner_user_id, requested_at=NOW(), status='pending',
      approved_by=NULL, approved_at=NULL`,
      [chat.id, chat.type, actor ?? null, creatorId]);
  }
  await sendLog({ module: "security", stage: "group_approval_required", severity: "warn", status: "pending", details: { chatId: chat.id, actor, ownerUserId: creatorId, chatType: chat.type } });
});

bot.action(/^panel:(home|chemical|prices|lists|merchants|deals|reports|protection|inactive|health|scraper_test|diagnostics)$/, async ctx => {
  if (ctx.chat?.type !== "private" || !(await isPrivateController(ctx.from?.id))) {
    await ctx.answerCbQuery("غير مصرح. اللوحة الخاصة للمالك فقط.", { show_alert: true }).catch(() => {});
    return;
  }
  const action = ctx.match[1];
  if (action === "home") { await showPrivatePanel(ctx, true); return; }
  await ctx.answerCbQuery().catch(() => {});
  if (action === "health") {
    let dbState = "غير متاح";
    try { await db.query("SELECT 1"); dbState = "متصل"; } catch (e) { dbState = `فشل (${String(e.code || e.message).slice(0,80)})`; }
    const body = `🩺 تشخيص النظام\nالإصدار: ${APP_VERSION}\nقاعدة البيانات: ${dbState}\nGPT providers: ${(ai.providers || []).join("، ") || "لا يوجد"}\nSCRAPER_API_KEY: ${process.env.SCRAPER_API_KEY ? "موجود (القيمة مخفية)" : "غير مضبوط"}\nSCRAPER_API_KEY_2: ${process.env.SCRAPER_API_KEY_2 ? "موجود (القيمة مخفية)" : "غير مضبوط"}\nوجهة النشرات: المجموعات المعتمدة النشطة من قاعدة البيانات\n\nهذا فحص إعدادات واتصال قاعدة البيانات، وليس إثباتًا لنجاح كل متجر أو API.`;
    await ctx.editMessageText(body, { reply_markup: adminPanel.actionKeyboard() }); return;
  }
  if (action === "prices") {
    let counts = [];
    let pending = [];
    let countsAvailable = true;
    try {
      const result = await db.query("SELECT decision, COUNT(*)::int AS n FROM price_observations GROUP BY decision");
      counts = result.rows;
    } catch {
      countsAvailable = false;
    }
    try {
      const result = await db.query(
        "SELECT product_text, package_sale_price, price_kind, confidence, raw_text, observed_at FROM price_observations WHERE decision='pending' ORDER BY observed_at DESC LIMIT 5"
      );
      pending = result.rows;
    } catch {
      countsAvailable = false;
    }
    const countText = countsAvailable
      ? ["accepted", "pending"].map(kind => {
          const row = counts.find(item => item.decision === kind);
          return `${kind === "accepted" ? "مرصودة بثقة عالية" : "تحتاج مراجعة"}: ${row?.n ?? 0}`;
        }).join("\n")
      : "تعذر قراءة ملخص الرصد من قاعدة البيانات؛ لم يتم تغيير أي سجل.";
    const pendingText = pending.length
      ? pending.map((row, i) => {
          const name = String(row.product_text || row.raw_text || "صنف غير محدد").replace(/\s+/g, " ").slice(0, 90);
          const price = Number(row.package_sale_price);
          const confidence = row.confidence == null ? "غير محددة" : `${Math.round(Number(row.confidence) * 100)}٪`;
          const date = row.observed_at ? new Date(row.observed_at).toLocaleString("ar-EG") : "وقت غير محدد";
          return `${i + 1}. ${name} — ${Number.isFinite(price) ? price.toFixed(2) + " ج.م" : "سعر غير واضح"}\n   النوع: ${row.price_kind || "غير محدد"} — الثقة: ${confidence} — ${date}`;
        }).join("\n")
      : "لا توجد سجلات معلقة حديثة، أو تعذر تحميلها.";
    await ctx.editMessageText(
      `💰 رصد الأسعار — مراجعة داخلية\n\n${countText}\n\nآخر الأسعار التي تحتاج مراجعة:\n${pendingText}\n\nهذه شاشة متابعة فقط؛ لا تعتمد الأسعار أو تعدّلها تلقائيًا. السعر الملتبس يظل قيد المراجعة.`,
      { reply_markup: adminPanel.actionKeyboard() }
    );
    return;
  }
  if (action === "scraper_test") {
    const result = await fetchSearch("amazon", "مسحوق غسيل", { timeoutMs: 70000 });
    const body = result.ok
      ? `🌐 اختبار ScraperAPI\nالحالة: اتصال HTTP ناجح\nالمصدر: Amazon.eg\nالعناصر المستخرجة: ${result.deals.length}\n\nتنبيه: الاتصال ناجح، لكن صفر عناصر قد يعني تغيّر صفحة المتجر أو حجب المحتوى.`
      : `🌐 اختبار ScraperAPI\nالحالة: فشل\nالسبب: ${result.reason || "unknown"}\n\nلم تُعرض قيمة المفتاح في التقرير.`;
    await sendLog({ module: "deals", stage: "manual_source_test", severity: result.ok ? "info" : "warn", status: result.ok ? "ok" : "failed", details: { source: "amazon", reason: result.reason || null, extracted: result.deals?.length || 0 } });
    await ctx.editMessageText(body, { reply_markup: adminPanel.actionKeyboard() }); return;
  }
  if (action === "diagnostics") {
    const r = await db.query("SELECT ts,module,stage,severity,status,details FROM diagnostic_events ORDER BY ts DESC LIMIT 8").catch(() => ({ rows: [] }));
    const body = r.rows.length ? r.rows.map((x,i)=>`${i+1}. ${new Date(x.ts).toLocaleString("ar-EG")} — ${x.severity}/${x.module}/${x.stage} — ${x.status}`).join("\n") : "لا توجد تقارير محفوظة أو تعذر قراءة جدول التشخيص.";
    await ctx.editMessageText(`📄 آخر تقارير الأخطاء\n${body}\n\nللحصول على التقرير الكامل، راجع قناة السجلات باستخدام Report ID.`, { reply_markup: adminPanel.actionKeyboard() }); return;
  }
  if (action === "reports") {
    const checks = [
      ["رصد الأسعار", "SELECT COUNT(*)::int AS n FROM price_observations"],
      ["قوائم الشركات", "SELECT COUNT(*)::int AS n FROM price_list_runs"],
      ["العروض المنشورة", "SELECT COUNT(*)::int AS n FROM deal_publications WHERE status='published'"],
      ["الإنذارات النشطة", "SELECT COUNT(*)::int AS n FROM member_warnings WHERE active=TRUE"],
      ["تقارير التشخيص", "SELECT COUNT(*)::int AS n FROM diagnostic_events"]
    ];
    const lines=[];
    for (const [label,sql] of checks) { try { const q=await db.query(sql); lines.push(`${label}: ${q.rows[0]?.n ?? 0}`); } catch { lines.push(`${label}: الجدول/الاستعلام غير متاح في هذا المخطط`); } }
    await ctx.editMessageText(`📊 ملخص التقارير\n${lines.join("\n")}\n\nالأعداد وصفية حسب السجلات الموجودة ولا تعني أن جميع مصادر البيانات الحية تعمل.`, { reply_markup: adminPanel.actionKeyboard() }); return;
  }
  const guides = {
    chemical: "🧪 المساعد الكيميائي\nأرسل سؤالك هنا في الخاص، أو اكتب /مساعد متبوعًا بالسؤال. سيولّد البوت إجابة وروابط بحث آمنة؛ التركيبات الخطرة تخضع لبوابة السلامة.",
    prices: "💰 رصد الأسعار\nالرصد التلقائي يعمل بصمت داخل المجموعة المصرح بها. أرسل سعرًا واضحًا في المجموعة، ولن تظهر رسالة لكل عملية رصد.",
    lists: "📋 قوائم الشركات\nاستخدم /قائمة ثم ألصق نص القائمة. لا ترسل رابطًا إلا إذا كانت الرسالة الأصلية قد مرّت على البوت وتم تخزين مرجعها. الصفوف غير الواضحة تُحال للمراجعة بدل التخمين.",
    merchants: "🏪 بيانات التجار\nتُحفظ البيانات فقط عند توافر مؤشرات موثوقة، ولا يطلب البوت من الأعضاء نشر بيانات شخصية بلا داعٍ.",
    deals: `🛍️ العروض\nحالة المفتاح: ${process.env.SCRAPER_API_KEY ? "موجود، استخدم زر اختبار المصدر" : "SCRAPER_API_KEY غير مضبوط"}\nوجهات النشر: المجموعات المعتمدة النشطة في قاعدة البيانات؛ لا يلزم ضبط DEALS_CHAT_ID\nلا تُنشر عروض مخترعة عند فشل المصدر.`,
    protection: "🛡️ الحماية والإنذارات\nالأوامر الإدارية /antispam و/warn و/warnings و/clearwarn متاحة للمصرح لهم فقط. الحذف التلقائي يظل معطلاً ما لم يُفعّل صراحةً في البيئة. إجراء الإعدادات لكل مجموعة سيبقى مرتبطًا بمعرّف المجموعة وليس الخاص.",
    inactive: "👥 الأعضاء الخاملون\nاستخدم /inactive 30 داخل المجموعة المصرح بها. التقرير يعتمد على نشاط الرسائل التي رصدها البوت منذ بدء التتبع، وليس تعدادًا كاملًا للأعضاء."
  };
  await ctx.editMessageText(guides[action] || "الخدمة غير متاحة حاليًا.", { reply_markup: adminPanel.actionKeyboard() });
});

bot.on("text", async ctx => {
  const m = messageData(ctx);
  if (!["group", "supergroup", "private"].includes(m.chatType)) return;
  if (isBotMessage(ctx, botUserId)) return;
  const text = m.text;
  const cmd = commandName(text);
  const args = commandText(text);
  if (cmd === "priceedit" && m.chatType === "private") {
    if (!(await isPrivateController(m.userId))) { await ctx.reply("هذا الإجراء متاح للمسؤولين المخوّلين فقط."); return; }
    const fields = args.split("|").map(value => value.trim());
    if (fields.length !== 6) { await ctx.reply("صيغة غير صحيحة. استخدم: /priceedit ID | اسم الصنف | السعر | الوزن_جرام أو - | الحجم_مللي أو - | عدد العبوات أو -"); return; }
    const [idText, productText, priceText, weightText, volumeText, packText] = fields;
    const id = Number(idText), price = Number(priceText.replace(",", "."));
    const parseOptional = value => value === "-" || value === "" ? null : Number(value.replace(",", "."));
    const weightG = parseOptional(weightText), volumeMl = parseOptional(volumeText), packCount = parseOptional(packText);
    if (!Number.isSafeInteger(id) || id < 1 || !productText || productText.length > 160 ||
        !Number.isFinite(price) || price <= 0 || price >= 100000 ||
        (weightG !== null && (!Number.isFinite(weightG) || weightG <= 0)) ||
        (volumeMl !== null && (!Number.isFinite(volumeMl) || volumeMl <= 0)) ||
        (packCount !== null && (!Number.isInteger(packCount) || packCount <= 0 || packCount > 1000))) {
      await ctx.reply("القيم غير صالحة. راجع رقم السجل واسم الصنف والسعر والوزن والحجم والعدد."); return;
    }
    try {
      const result = await priceReview.saveEditedReview({ db, id, reviewerId: m.userId, productText, price, weightG, volumeMl, packCount });
      if (!result.ok) { await ctx.reply("لم يتم التعديل: السجل غير موجود أو تمت مراجعته مسبقًا."); return; }
      const queue = await db.query("SELECT log_chat_id, log_message_id FROM price_review_queue WHERE observation_id=$1", [id]);
      const target = queue.rows[0];
      let buttonsRemoved = false;
      if (target?.log_chat_id && target?.log_message_id) {
        try {
          await ctx.telegram.editMessageText(target.log_chat_id, target.log_message_id, undefined,
            `✏️ تم تعديل واعتماد سجل السعر #${id}\nالصنف: ${productText}\nالسعر: ${price.toFixed(2)} ج.م\nنوع السعر: جملة\nالمراجع: ${m.userId}`,
            { reply_markup: { inline_keyboard: [] } });
          buttonsRemoved = true;
        } catch (editError) {
          await sendLog({ module: "price-monitor", stage: "review_edit_clear_buttons", severity: "warn", status: "failed", details: { observationId: id, error: redactString(editError?.message || "could not clear review buttons") } });
        }
      }
      await ctx.reply(buttonsRemoved
        ? "تم حفظ التعديل واعتماد السعر، وأزيلت أزرار المراجعة من رسالة السجل."
        : "تم حفظ التعديل واعتماد السعر، لكن تعذر تحديث رسالة المراجعة أو إزالة أزرارها. يرجى مراجعة قناة السجل.");
    } catch (error) {
      await ctx.reply("تعذر حفظ التعديل. لم يتم تأكيد نجاح العملية؛ راجع لوحة الأسعار وحاول لاحقًا.");
      await sendLog({ module: "price-monitor", stage: "review_edit", severity: "error", status: "failed", details: { observationId: id, error: redactString(error?.message || "review edit failed") } });
    }
    return;
  }


  // /claim submits a request only; it never grants group access.
  if (cmd === "claim" && ["group", "supergroup"].includes(m.chatType)) {
    try {
      const admins = await ctx.telegram.getChatAdministrators(m.chatId);
      const creator = admins.find(a => a.status === "creator")?.user;
      if (!creator || String(creator.id) !== String(m.userId)) {
        await ctx.reply("يمكن لمنشئ المجموعة الأصلي فقط طلب الاعتماد. التفعيل يتطلب موافقة مالك البوت.");
        return;
      }
      // An already approved group must not be disabled by an unnecessary repeat claim.
      if (await isAuthorizedChat(m.chatId)) {
        await ctx.reply("هذه المجموعة معتمدة بالفعل. لا حاجة لإرسال طلب جديد.");
        return;
      }
      // A new claim remains inactive until the fixed bot owner explicitly approves it.
      await db.query("UPDATE authorized_chats SET active=FALSE WHERE chat_id=$1", [m.chatId]);
      await db.query(`INSERT INTO pending_group_approvals(chat_id,chat_type,requested_by,owner_user_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(chat_id) DO UPDATE SET
        chat_type=EXCLUDED.chat_type, requested_by=EXCLUDED.requested_by,
        owner_user_id=EXCLUDED.owner_user_id, requested_at=NOW(), status='pending',
        approved_by=NULL, approved_at=NULL`,
        [m.chatId, m.chatType, m.userId, creator.id]);
      await ctx.reply("تم تسجيل طلب الاعتماد. ستبقى خدمات البوت متوقفة لهذه المجموعة حتى موافقة مالك البوت.");
      try { await ctx.telegram.sendMessage(5256328556, `طلب اعتماد مجموعة جديدة\nالمعرّف: ${m.chatId}\nمنشئ المجموعة: ${creator.id}\nللموافقة أرسل في الخاص: /approvechat ${m.chatId}`); } catch {}
      await sendLog({ module: "security", stage: "group_claim_requested", status: "pending", details: { chatId: m.chatId, ownerUserId: creator.id, actor: m.userId } });
    } catch (error) {
      await ctx.reply("تعذر تسجيل الطلب. تأكد من اتصال قاعدة البيانات ثم أعد المحاولة.");
      await sendLog({ module: "security", stage: "group_claim", severity: "warn", status: "failed", details: { chatId: m.chatId, code: error.code || null } });
    }
    return;
  }

  // Only the bot master may approve a group, and only from a private chat.
  if (cmd === "approvechat" && m.chatType === "private") {
    if (Number(m.userId) !== MASTER_ID) { await ctx.reply("هذا الأمر متاح لمالك البوت المحدد فقط."); return; }
    const targetId = Number(args.split(/\s+/)[0]);
    if (!Number.isSafeInteger(targetId) || targetId >= 0) { await ctx.reply("الصيغة: /approvechat -1001234567890"); return; }
    try {
      const pending = await db.query("SELECT chat_type,owner_user_id FROM pending_group_approvals WHERE chat_id=$1 AND status='pending'", [targetId]);
      if (!pending.rows[0]) { await ctx.reply("لا يوجد طلب اعتماد معلّق لهذا المعرّف."); return; }
      if (!["group", "supergroup"].includes(pending.rows[0].chat_type)) {
        await ctx.reply("نوع المحادثة غير مدعوم للاعتماد؛ يُسمح بالمجموعات والمجموعات الفائقة فقط.");
        return;
      }
      const admins = await ctx.telegram.getChatAdministrators(targetId);
      const creator = admins.find(a => a.status === "creator")?.user;
      if (!creator || (pending.rows[0].owner_user_id != null && String(creator.id) !== String(pending.rows[0].owner_user_id))) {
        await ctx.reply("تعذر التحقق من منشئ المجموعة الحالي؛ لم يتم اعتمادها.");
        return;
      }
      await approvePendingGroup({
        db,
        chatId: targetId,
        chatType: pending.rows[0].chat_type,
        ownerUserId: creator.id,
        approvedBy: m.userId
      });
      await ctx.reply(`تم اعتماد المجموعة بنجاح.\nالمعرّف: ${targetId}\nمنشئ المجموعة: ${creator.id}\nالمعتمد: مالك البوت.`);
      try { await ctx.telegram.sendMessage(targetId, "وافق مالك البوت على تفعيل خدمات البوت في هذه المجموعة."); } catch {}
      await sendLog({ module: "security", stage: "group_approved_by_master", status: "ok", details: { chatId: targetId, ownerUserId: creator.id, approvedBy: m.userId } });
    } catch (error) {
      await ctx.reply("فشل اعتماد المجموعة؛ راجع صلاحيات البوت واتصال قاعدة البيانات.");
      await sendLog({ module: "security", stage: "group_approval_failed", severity: "warn", status: "failed", details: { chatId: targetId, code: error.code || null } });
    }
    return;
  }
  if (m.chatType !== "private" && !(await isAuthorizedChat(m.chatId))) return;

  // Ordinary members may use automatic services, but slash commands are controller-only.
  const isChemicalCommand = ["مساعد", "كيمياء", "المساعد_الكيميائي", "chemical", "chem"].includes(cmd);
  if (cmd && !isChemicalCommand && !(await canControl(ctx, m))) return;

  if ((cmd === "panel" || cmd === "start" || cmd === "settings") && m.chatType === "private") {
    await showPrivatePanel(ctx, false);
    return;
  }

  if (cmd === "قائمة" || cmd === "pricelist") {
    if (!(await canControl(ctx, m))) return;
    let sourceText = args;
    const link = parseMessageLink(args);
    if (link) {
      const source = link.chatId ? await getMessageByRef(db.pool, link.chatId, link.messageId) : null;
      if (!source) {
        await ctx.reply("🔎 الرابط مفهوم، لكن الرسالة الأصلية لم تمر على البوت من قبل. أعد توجيه الرسالة هنا أو أرسل نص القائمة بعد الأمر /قائمة.");
        return;
      }
      sourceText = source.text || source.caption || "";
    }
    if (!sourceText || !isListLike(sourceText)) {
      await ctx.reply("لم أجد قائمة أسعار مكتملة بما يكفي. أرسل النص تحت /قائمة أو أرسل رابط رسالة سبق أن رآها البوت.");
      return;
    }
    const parsedList = await extractList(ai, sourceText);
    const rows = Array.isArray(parsedList.items) ? parsedList.items : deterministicList(sourceText);
    const accepted = rows.filter(r => r.decision === "accepted");
    if (db.pool) {
      await db.withTransaction(async client => {
        const run = await client.query(`INSERT INTO price_list_runs(source_chat_id,source_message_id,raw_text,status,extracted_count,accepted_count,skipped_count)
          VALUES($1,$2,$3,'processed',$4,$5,$6) RETURNING id`, [m.chatId, m.messageId, sourceText, rows.length, accepted.length, rows.length - accepted.length]);
        for (const row of rows) {
          await client.query(`INSERT INTO price_list_items(run_id,product_label,variant_label,company_label,weight_g,volume_ml,package_sale_price,wholesale_carton_price,consumer_price,pack_count,confidence,raw_line,decision,unit_price_type,list_price)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [run.rows[0].id, row.product || row.product_text || null, row.variant || null, row.company || parsedList.company || null, row.weight_g ?? null, row.volume_ml ?? null, row.package_sale_price ?? null, row.wholesale_carton_price ?? null, row.consumer_price ?? null, row.pack_count ?? null, row.confidence ?? null, row.raw_line || row.rawLine || null, row.decision || "review", row.unit_price_type || null, row.list_price ?? null]);
        }
      });
    }
    await sendLog({ module: "price-list", stage: "processed", status: "ok", details: { actor: m.userId, extracted: rows.length, accepted: accepted.length, method: parsedList.method, company: parsedList.company || null } });
    const companyNames = [...new Set(accepted.map(row => String(row.company || parsedList.company || "").trim()).filter(Boolean))];
    if (accepted.length >= 3 && companyNames.length === 1 && typeof ctx.replyWithPhoto === "function") {
      try {
        const images = await renderPriceListImages({ company: companyNames[0], items: accepted, watermark: "بورصة المنظفات لأصحاب المحلات", month: parsedList.month || null, priceType: parsedList.priceType || "أسعار جملة" });
        const caption = `📋 قائمة أسعار ${companyNames[0]}\n${parsedList.month ? `الفترة: ${parsedList.month}\n` : ""}${parsedList.priceType || "أسعار جملة"}\nالأصناف المنشورة: ${accepted.length}\nعدد الصور: ${images.length}\n${BOT_CREDIT}`;
        if (typeof ctx.replyWithMediaGroup === "function" && images.length > 1) {
          await ctx.replyWithMediaGroup(images.map((image, i) => ({ type: "photo", media: { source: image, filename: `borsa-price-list-${i + 1}.png` }, ...(i === 0 ? { caption } : {}) })));
        } else {
          for (let i = 0; i < images.length; i++) {
            await ctx.replyWithPhoto({ source: images[i], filename: `borsa-price-list-${i + 1}.png` }, { caption: `${caption}\nصفحة ${i + 1} من ${images.length}` });
          }
        }
        await sendLog({ module: "price-list", stage: "image_published", status: "ok", details: { actor: m.userId, count: accepted.length, pages: images.length, company: companyNames[0] } });
      } catch (error) {
        await sendLog({ module: "price-list", stage: "image_publish", severity: "warn", status: "failed", details: { code: error.code || null, message: error.message } });
        await ctx.reply(`تم حفظ القائمة، لكن تعذر إنشاء أو نشر الصورة. رقم التقرير التشخيصي محفوظ.\nالأصناف الواضحة: ${accepted.length}`);
      }
    } else {
      await ctx.reply(`✅ تمت قراءة القائمة في صمت.\nالأصناف الواضحة: ${accepted.length}\nالمراجعة: ${rows.length - accepted.length}\n\n${BOT_CREDIT}`);
    }
    return;
  }

  if (isChemicalCommand) {
    if (!["group", "supergroup"].includes(m.chatType)) return;
    const question = args || "اكتب سؤالك الكيميائي بوضوح.";
    const answer = await chemical.answer(chemicalAI, question, error => log({ module: "chemical-assistant", stage: `${error?.aiProvider || "provider_unknown"}_request`, severity: "error", status: "safe_fallback", input: question, details: { provider: error?.aiProvider || "unknown", message: error?.message || "AI provider request failed" } }));
    const links = buildChemicalLinks(question);
    const mention = ctx.from?.username ? `@${ctx.from.username}\n` : "";
    const body = `🧪 المساعد الكيميائي\n\n${mention}${require("./core/links").escapeHtml(answer)}${renderChemicalLinks(links) ? `\n\n${renderChemicalLinks(links)}` : ""}\n\nأهل الخبرة في الجروب، نرحب بمشاركاتكم وتجاربكم الفنية المرتبطة بالسؤال.`;
    await ctx.reply(body, { reply_to_message_id: m.messageId, parse_mode: "HTML", disable_web_page_preview: true });
    return;
  }

  if (cmd === "settings" || cmd === "admin") {
    if (!(await canControl(ctx, m))) return;
    const chatId = m.chatId;
    const settings = await db.query("SELECT * FROM moderation_settings WHERE chat_id=$1", [chatId]).catch(() => ({ rows: [] }));
    const mod = settings.rows[0] || { anti_spam_enabled: true, block_excessive_links: true, max_links: 5, block_untrusted_forwards: false };
    const jobs = await scheduler.listScheduledMessages(db.pool, chatId).catch(() => []);
    await ctx.reply(`🛡️ لوحة الإدارة — ${APP_VERSION}\n\nحماية الرسائل: ${mod.anti_spam_enabled ? "مفعّلة (رصد آمن)" : "متوقفة"}\nحذف تلقائي: ${process.env.PROTECTION_ENFORCE === "true" ? "مفعّل" : "غير مفعّل — مراجعة فقط"}\nالرسائل المجدولة: ${jobs.length}\n\nالأوامر: /antispam on أو /antispam off\n/schedule YYYY-MM-DDTHH:mm نص الرسالة\n/weather اسم المدينة\n\n${BOT_CREDIT}`);
    return;
  }

  if (cmd === "antispam") {
    if (!(await canControl(ctx, m))) return;
    const mode = args.toLowerCase();
    if (!["on", "off"].includes(mode)) { await ctx.reply("استخدم /antispam on أو /antispam off"); return; }
    await db.query(`INSERT INTO moderation_settings(chat_id,anti_spam_enabled,updated_by) VALUES($1,$2,$3) ON CONFLICT(chat_id) DO UPDATE SET anti_spam_enabled=EXCLUDED.anti_spam_enabled,updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [m.chatId, mode === "on", m.userId]);
    await ctx.reply(`تم ${mode === "on" ? "تفعيل" : "إيقاف"} رصد الرسائل المزعجة. وضع الحذف التلقائي ${process.env.PROTECTION_ENFORCE === "true" ? "مفعّل" : "غير مفعّل"}.`);
    return;
  }

  if (cmd === "schedule") {
    if (!(await canControl(ctx, m))) return;
    const match = args.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?:\s+)([\s\S]+)$/);
    if (!match) { await ctx.reply("الصيغة: /schedule 2026-10-13T17:00 نص الرسالة\nالموعد يُفسَّر بتوقيت القاهرة Africa/Cairo."); return; }
    try {
      const local = match[1];
      const runAt = parseLocalDateTime(local, "Africa/Cairo");
      const job = await scheduler.createScheduledMessage(db.pool, { chat_id: m.chatId, run_at: runAt, timezone: "Africa/Cairo", message_text: match[2], created_by: m.userId });
      await ctx.reply(`✅ تمت إضافة الرسالة المجدولة رقم ${job.id}.`);
    } catch (error) { await ctx.reply(`تعذر إنشاء الجدولة: ${error.message}`); }
    return;
  }

  if (cmd === "weather" || cmd === "الطقس") {
    const city = args || "القاهرة";
    const result = await weather.getWeatherSummary(ai, city);
    await ctx.reply(`${result.message}${result.ok ? "" : `\n🔎 بحث الطقس: ${result.searchUrl}`}`, { disable_web_page_preview: true });
    return;
  }

  if (["warn", "warnings", "clearwarn", "inactive"].includes(cmd)) {
    if (!(await canControl(ctx, m))) return;
    if (cmd === "inactive") {
      const days = Number(args) || 30;
      const rows = await legacyAdmin.listInactive(db.pool, m.chatId, days, 20);
      const body = rows.length ? rows.map((r,i)=>`${i+1}. ${r.display_name || r.username || r.user_id} — ${r.inactive_days} يوم — ${r.message_count} رسالة`).join("\n") : "لا توجد بيانات أعضاء مسجلة خاملة لهذه المدة. التقرير يعتمد على الأعضاء الذين رصد البوت نشاطهم منذ تفعيل التتبع، وليس تعدادًا كاملًا لأعضاء تيليجرام.";
      await ctx.reply(`📊 تقرير النشاط (أكثر من ${Math.max(1,Math.min(365,days))} يوم):\n${body}`);
      return;
    }
    const match = args.match(/^(\d+)(?:\s+([\s\S]+))?$/);
    if (!match) { await ctx.reply(`الصيغة: /${cmd} USER_ID${cmd === "warn" ? " سبب الإنذار" : ""}`); return; }
    const targetUserId = Number(match[1]);
    if (cmd === "warn") {
      const result = await legacyAdmin.addWarning(db.pool, { chatId: m.chatId, userId: targetUserId, issuedBy: m.userId, reason: match[2] || "مخالفة قواعد المجموعة" });
      await sendLog({ module: "moderation", stage: "warning_issued", severity: result.count >= 3 ? "warn" : "info", status: "ok", details: { chatId: m.chatId, userId: targetUserId, warningId: result.id, activeWarnings: result.count } });
      await ctx.reply(`⚠️ تم تسجيل الإنذار رقم ${result.id} للعضو ${targetUserId}.\nالإنذارات النشطة: ${result.count}\n${result.count >= 3 ? "وصل العضو إلى 3 إنذارات؛ راجع الحالة قبل أي إجراء تقييدي." : ""}`);
    } else if (cmd === "warnings") {
      const rows = await legacyAdmin.listWarnings(db.pool, m.chatId, targetUserId);
      await ctx.reply(rows.length ? `⚠️ إنذارات العضو ${targetUserId}:\n${rows.map(r=>`#${r.id} — ${r.reason} — ${new Date(r.created_at).toLocaleString("ar-EG")}`).join("\n")}` : `لا توجد إنذارات نشطة للعضو ${targetUserId}.`);
    } else {
      const count = await legacyAdmin.clearWarnings(db.pool, { chatId: m.chatId, userId: targetUserId, clearedBy: m.userId });
      await ctx.reply(`تم إغلاق ${count} إنذارًا للعضو ${targetUserId}.`);
      await sendLog({ module: "moderation", stage: "warnings_cleared", status: "ok", details: { chatId: m.chatId, userId: targetUserId, count, actor: m.userId } });
    }
    return;
  }

  if (cmd) return; // commands are intentionally invisible/unusable to unauthorized users

  if (!priceMonitor.isEligibleMessage({ chatType: m.chatType, text: text || m.caption || "", isLogChannel: false, isCommand: false, ownMessage: isBotMessage(ctx, botUserId) })) return;

  let merchantId = null;
  const phone = text.match(/(?:\+?20|0)?1\d{9,10}/)?.[0];
  if (phone && /(سعر|جنيه|ج\s|مسحوق|جيل|منظف|تاجر|محل)/i.test(text)) {
    try {
      const saved = await saveMerchant(db.pool, {
        name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "تاجر غير مسمى",
        activity: "مرصد أسعار",
        location: "غير محدد",
        phone,
        telegram_username: ctx.from?.username || null,
      }, { chatId: m.chatId, messageId: m.messageId, userId: m.userId, rawText: text });
      merchantId = saved.merchant?.id || null;
      if (saved.saved) await sendLog({ module: "merchant", stage: saved.updated ? "updated" : "new", status: "ok", details: { merchantId, name: saved.merchant?.name } });
    } catch (e) { await sendLog({ module: "merchant", stage: "save", severity: "error", status: "failed", details: { error: e.message } }); }
  }

  // Silent price observation runs independently of AI intent classification.
  // A classification miss must never prevent a plausible price from being recorded.
  try {
    const result = await priceMonitor.observe({ pool: db.pool, message: m, merchantId, registry });
    if (result.saved > 0) {
      const pendingRows = result.savedRows.filter(item => item.row.decision === "pending");
      for (const item of pendingRows) {
        try {
          const queued = await db.query(
            `INSERT INTO price_review_queue(observation_id, source_chat_id, log_chat_id)
             VALUES($1,$2,$3) ON CONFLICT(observation_id) DO NOTHING RETURNING id`,
            [item.id, m.chatId || null, LOG_CHAT_ID]
          );
          if (!queued.rowCount) continue;
          const sent = await bot.telegram.sendMessage(LOG_CHAT_ID, priceReview.formatReviewMessage(item.id, item.row), {
            reply_markup: priceReview.reviewKeyboard(item.id), disable_web_page_preview: true
          });
          await db.query("UPDATE price_review_queue SET log_message_id=$1 WHERE observation_id=$2", [sent.message_id, item.id]);
        } catch (reviewError) {
          await sendLog({ module: "price-monitor", stage: "review_notification", severity: "warn", status: "failed", details: { observationId: item.id, error: redactString(reviewError?.message || "review notification failed") } });
        }
      }
      await sendLog({
        module: "price-monitor",
        stage: "saved",
        status: "ok",
        details: { saved: result.saved, pending: pendingRows.length, candidates: result.accepted.length, merchantId, messageId: m.messageId }
      });
    }
  } catch (error) {
    await sendLog({
      module: "price-monitor",
      stage: "save_observation",
      severity: "error",
      status: "failed",
      details: { chatId: m.chatId, messageId: m.messageId, error: redactString(error?.message || "price observation failed") }
    });
  }

  // In approved groups, automatically answer likely chemistry questions once per incoming message.
  if (ctx.message && ["group", "supergroup"].includes(m.chatType) && chemical.isChemicalQuestion(text)) {
    const answer = await chemical.answer(chemicalAI, text, error => log({ module: "chemical-assistant", stage: `${error?.aiProvider || "provider_unknown"}_request`, severity: "error", status: "safe_fallback", input: text, details: { provider: error?.aiProvider || "unknown", message: error?.message || "AI provider request failed" } }));
    const links = buildChemicalLinks(text);
    const body = `🧪 المساعد الكيميائي\n\n${ctx.from?.username ? `@${ctx.from.username}\n` : ""}${require("./core/links").escapeHtml(answer)}${renderChemicalLinks(links) ? `\n\n${renderChemicalLinks(links)}` : ""}\n\nأهل الخبرة في الجروب، نرحب بمشاركاتكم وتجاربكم الفنية المرتبطة بالسؤال.`;
    await ctx.reply(body, { reply_to_message_id: m.messageId, parse_mode: "HTML", disable_web_page_preview: true });
    return;
  }


});


bot.action(/^prv:(approve|new|ignore):(\d+)$/, async ctx => {
  if (!isLogChat(ctx.chat?.id) || !(await isPrivateController(ctx.from?.id))) {
    await ctx.answerCbQuery("غير مصرح بمراجعة الأسعار من هذه المحادثة.", { show_alert: true }).catch(() => {});
    return;
  }
  const action = ctx.match[1], id = Number(ctx.match[2]);
  let resolved = false;
  try {
    const result = await priceReview.resolveReview({ db, id, action, reviewerId: ctx.from.id });
    if (!result.ok) {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
      await ctx.answerCbQuery("تمت معالجة هذا السجل سابقًا أو لم يعد معلّقًا.", { show_alert: true }).catch(() => {});
      return;
    }
    resolved = true;
    await ctx.answerCbQuery(action === "ignore" ? "تم تجاهل السجل." : "تم اعتماد السجل.");
    const status = action === "ignore" ? "🚫 تم التجاهل" : action === "new" ? "🆕 تم اعتماد السعر والصنف الجديد" : "✅ تم اعتماد السعر";
    const original = ctx.callbackQuery.message?.text || `مراجعة السعر #${id}`;
    await ctx.editMessageText(`${original}\n\n${status} — بواسطة المسؤول ${ctx.from.id}`, { reply_markup: { inline_keyboard: [] } });
  } catch (error) {
    if (resolved) await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.answerCbQuery(resolved ? "تم الحفظ، وحاول البوت إزالة الأزرار مرة أخرى." : "تعذر حفظ القرار. لم تُزل أزرار المراجعة؛ حاول مرة أخرى.", { show_alert: true }).catch(() => {});
    await sendLog({ module: "price-monitor", stage: "review_action", severity: "error", status: "failed", details: { observationId: id, action, error: redactString(error?.message || "review action failed") } });
  }
});

bot.action(/^prv:edit:(\d+)$/, async ctx => {
  if (!isLogChat(ctx.chat?.id) || !(await isPrivateController(ctx.from?.id))) {
    await ctx.answerCbQuery("غير مصرح بمراجعة الأسعار من هذه المحادثة.", { show_alert: true }).catch(() => {});
    return;
  }
  const id = Number(ctx.match[1]);
  const prompt = `✏️ تعديل سجل السعر #${id}\n\nأرسل الأمر التالي في الخاص بعد استبدال القيم، مع الفصل بعلامة | :\n/priceedit ${id} | اسم الصنف | السعر | الوزن_بالجرام أو - | الحجم_بالمللي أو - | عدد العبوات أو -\n\nسيُحفظ السعر المعدل كسعر جملة معتمد. لا تستخدمه إذا لم تتأكد أن السعر سعر جملة.`;
  try { await ctx.telegram.sendMessage(ctx.from.id, prompt); await ctx.answerCbQuery("أرسلت تعليمات التعديل إلى الخاص."); }
  catch { await ctx.answerCbQuery("تعذر مراسلتك على الخاص. افتح محادثة البوت أولًا ثم أعد المحاولة.", { show_alert: true }).catch(() => {}); }
});

bot.catch(async (err, ctx) => {
  const m = messageData(ctx || {});
  const report = makeReport({ module: "bot", stage: ctx?.updateType || "unknown", severity: "ERROR", action: "telegram_update", error: err, input: m.text || m.caption, chatId: m.chatId, messageId: m.messageId, details: { appVersion: APP_VERSION } });
  await emitReport({ bot, db, report });
});

installFatalProcessHandlers({
  reportFatal: async (stage, err) => {
    const report = makeReport({ module: "process", stage, severity: "CRITICAL", action: stage === "unhandledRejection" ? "promise_rejection" : "uncaught_exception", error: err, details: { appVersion: APP_VERSION } });
    await emitReport({ bot, db, report });
  },
  shutdown,
  timeoutMs: 10_000,
});

(async () => {
  await ensureDb();
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  const me = await bot.telegram.getMe();
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  botUserId = me.id;
  await configureCommandMenus().catch(error => sendLog({ module: "security", stage: "command_menu_setup", severity: "warn", status: "failed", details: { code: error.code || null, message: error.message } }));
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  console.log(`Borsa GBT Bot V1 Mona Lisa ${APP_VERSION} — @${me.username} — ${BOT_CREDIT}`);
  console.log(`AI providers configured: ${ai.providers.join(", ") || "none"}`);
  await scheduler.ensureSchedulerSchema(db.pool);
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  stopScheduledMessages = scheduler.startScheduler({ pool: db.pool, telegram: bot.telegram, onError: async (error, job) => {
    const report = makeReport({ module: "scheduler", stage: "dispatch_due", severity: "ERROR", action: "scheduled_message", error, details: { jobId: job?.id, chatId: job?.chat_id }, chatId: job?.chat_id });
    await emitReport({ bot, db, report });
  } });
  // Deal newsletters resolve their destinations from currently approved groups.
  // DEALS_CHAT_ID is no longer required for group selection.
  stopDeals = startDealScheduler({ pool: db.pool, telegram: bot.telegram, onError: async (error, details) => {
    const report = makeReport({ module: "deals", stage: details?.stage || "daily_cycle", severity: "ERROR", action: "deal_newsletter", error, details });
    await emitReport({ bot, db, report });
  } });
  // Catalog notices target every active, approved group from authorized_chats.
  stopCatalogs = startCatalogNewsletterScheduler({
    pool: db.pool,
    telegram: bot.telegram,
    onError: async (error, details) => {
      const report = makeReport({ module: "catalog_newsletter", stage: details?.stage || "daily_check", severity: "ERROR", action: "catalog_newsletter", error, details });
      await emitReport({ bot, db, report });
    }
  });
  console.log("[CATALOG_NEWSLETTER_SCHEDULER] Daily check scheduled for 10:10 Africa/Cairo; targets active approved groups.");
  await ensureEconomicNewsletterSchema(db.pool);
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  stopEconomicNewsletter = startEconomicNewsletterScheduler({
    pool: db.pool,
    telegram: bot.telegram,
    onError: async (error, details) => {
      const report = makeReport({ module: "economic_newsletter", stage: details?.stage || "daily_cycle", severity: "ERROR", action: "economic_bulletin", error, details });
      await emitReport({ bot, db, report });
    }
  });
  console.log("[ECONOMIC_NEWSLETTER_SCHEDULER] Daily bulletin scheduled for 10:30 Africa/Cairo; targets active approved groups.");
  if (String(process.env.WEATHER_SCHEDULER_ENABLED || "").toLowerCase() !== "false") {
    await ensureWeatherSchedulerSchema(db.pool);
    if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
    stopWeather = startWeatherScheduler({ pool: db.pool, telegram: bot.telegram, onError: async (error, details) => {
      const report = makeReport({ module: "weather", stage: details?.stage || "scheduled_bulletin", severity: "ERROR", action: "weather_bulletin", error, details });
      await emitReport({ bot, db, report });
    } });
  } else {
    console.log("[WEATHER_SCHEDULER_DISABLED] WEATHER_SCHEDULER_ENABLED=false; scheduled weather bulletins are disabled.");
  }
  // Webhook-only transport; polling transport is not used by this runtime.
  const allowedUpdates = [
    "message", "edited_message", "callback_query", "my_chat_member",
    "chat_member", "chat_join_request", "channel_post", "edited_channel_post"
  ];
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  webhookServer = createWebhookServer(bot, webhookConfig);
  await new Promise((resolve, reject) => {
    const onError = error => { webhookServer.removeListener("listening", onListening); reject(error); };
    const onListening = () => { webhookServer.removeListener("error", onError); resolve(); };
    webhookServer.once("error", onError);
    webhookServer.once("listening", onListening);
    webhookServer.listen(webhookConfig.port, "0.0.0.0");
  });
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  await bot.telegram.setWebhook(webhookConfig.url, {
    secret_token: webhookConfig.secret,
    allowed_updates: allowedUpdates,
    drop_pending_updates: false
  });
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  console.log(`[TELEGRAM_WEBHOOK_ACTIVE] path=${webhookConfig.path} port=${webhookConfig.port} allowedUpdates=${allowedUpdates.join(",")}`);
  startupPhase = false;
})().catch(async err => {
  if (shutdownRequested) {
    try { await shutdown("STARTUP_CANCELLED"); }
    catch (shutdownError) { console.error("[STARTUP_SHUTDOWN_FAILED]", redactString(shutdownError?.message || shutdownError)); }
    return;
  }
  console.error("STARTUP_FAILED\n" + redactString(formatTelegramStartupError(err)));
  try { await shutdown("STARTUP_FAILURE"); }
  catch (shutdownError) { console.error("[STARTUP_SHUTDOWN_FAILED]", redactString(shutdownError?.message || shutdownError)); }
  process.exit(1);
});

async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[SHUTDOWN] ${signal}: stopping schedulers and closing connections`);
    try { stopScheduledMessages(); } catch (error) { console.error("[SHUTDOWN_SCHEDULER_ERROR]", error?.message || error); }
    try { stopDeals(); } catch (error) { console.error("[SHUTDOWN_DEALS_ERROR]", error?.message || error); }
    try { stopCatalogs(); } catch (error) { console.error("[SHUTDOWN_CATALOGS_ERROR]", error?.message || error); }
    try { stopWeather(); } catch (error) { console.error("[SHUTDOWN_WEATHER_ERROR]", error?.message || error); }
    try { stopEconomicNewsletter(); } catch (error) { console.error("[SHUTDOWN_ECONOMIC_NEWSLETTER_ERROR]", error?.message || error); }
    if (webhookServer?.listening) {
      try { await new Promise((resolve, reject) => webhookServer.close(error => error ? reject(error) : resolve())); }
      catch (error) { console.error("[SHUTDOWN_WEBHOOK_SERVER_ERROR]", error?.message || error); process.exitCode = 1; }
    }
    try { await db.close(); } catch (error) { console.error("[SHUTDOWN_DATABASE_ERROR]", error?.message || error); process.exitCode = 1; }
  })();
  return shutdownPromise;
}

function requestShutdown(signal) {
  shutdownRequested = true;
  // During startup, let the active awaited step settle before closing PostgreSQL;
  // the startup flow checks this flag between steps and performs the one shutdown.
  if (startupPhase) return;
  void shutdown(signal);
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));
