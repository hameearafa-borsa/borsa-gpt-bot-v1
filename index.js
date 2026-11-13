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
const { parseMessageLinks, findCachedLinkedMessage } = require("./core/telegram-message-link");
const { log, makeReport, emitReport, redactString } = require("./core/diagnostics");
const { buildChemicalLinks, renderChemicalLinks } = require("./core/links");
const { formatTelegramStartupError } = require("./core/telegram-startup-error");
const { installFatalProcessHandlers } = require("./core/fatal-process");
const { send: logChannel, LOG_CHAT_ID } = require("./core/log-channel");
const { markTelegramRateLimited, isTelegramRateLimit, isTelegramRateLimitedNow } = require("./core/telegram-rate-limit");
const { MASTER_ID, isMaster, isReviewOperator, isChatOwner, canManage } = require("./core/permissions");
const { approvePendingGroup } = require("./core/group-approval");
const { isListLike, deterministicList, extractList } = require("./modules/price-list");
const { persistPriceList } = require("./modules/price-list-persistence");
const { renderPriceListImages } = require("./modules/price-list-image");
const priceMonitor = require("./modules/price-monitor");
const priceReferenceComparison = require("./modules/price-reference-comparison");
const priceReview = require("./modules/price-review");
const priceReviewRecovery = require("./modules/price-review-recovery");
const { saveMerchant } = require("./modules/merchant-intelligence");
const chemical = require("./modules/chemical-assistant");
const deals = require("./modules/deals");
const adminPanel = require("./modules/admin-panel");
const serviceSettings = require("./core/service-settings");



const weather = require("./modules/weather");
const { ensureWeatherSchedulerSchema, startWeatherScheduler } = require("./modules/weather-scheduler");
const { startDealScheduler } = require("./modules/deal-scheduler");



const { startCatalogNewsletterScheduler } = require("./modules/catalog-newsletter-scheduler");
const { ensureEconomicNewsletterSchema, startEconomicNewsletterScheduler } = require("./modules/economic-newsletter");
const { ensurePriceDigestSchema, startPriceDigestScheduler } = require("./modules/price-digest-scheduler");
const { ensurePrayerAlertsSchema, startPrayerAlertScheduler } = require("./modules/prayer-alert-scheduler");

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
// Gemini remains primary; chemical rescue rotates OpenAI keys, then tries Groq within a shared time budget.
const chemicalAI = createAI({ provider: "gemini" });
const chemicalFallbackAI = createAI({ provider: "openai", fallbackProviders: ["groq"] });
let botUserId = null;
let stopDeals = () => {};
let stopCatalogs = () => {};
let stopWeather = () => {};
let stopEconomicNewsletter = () => {};
let stopPriceDigest = () => {};
let stopPrayerAlerts = () => {};
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

async function isAuthorizedChat(chatId) {
  if (!db.pool) return false;
  const r = await db.query(`SELECT active FROM authorized_chats WHERE chat_id=$1`, [chatId]);
  return Boolean(r.rows[0]?.active);
}

// Explicitly trusted review operator for the shared board/admin group.
const ADDITIONAL_PRICE_REVIEWER_IDS = new Set([831621854]);

async function isPriceReviewer(telegram, userId) {
  if (isMaster(userId) || isReviewOperator(userId) || ADDITIONAL_PRICE_REVIEWER_IDS.has(Number(userId))) return true;
  if (!db.pool || !telegram || !userId) return false;
  try {
    const groups = await db.query("SELECT chat_id FROM authorized_chats WHERE active=TRUE");
    // Check active group creators concurrently. Serial Telegram admin lookups can
    // outlive Telegram's callback spinner and make review buttons appear unresponsive.
    const ownerChecks = await Promise.all((groups.rows || []).map(row =>
      isChatOwner(telegram, row.chat_id, userId)
    ));
    return ownerChecks.some(Boolean);
  } catch (error) {
    console.warn(`[PRICE_REVIEW_AUTH_CHECK_FAILED] code=${error?.code || "unknown"} message=${redactString(error?.message || "authorization lookup failed")}`);
  }
  return false;
}

const GROUP_COMMANDS = [
  { command: "settings", description: "إعدادات البوت وحالة المجموعة" },
  { command: "chemical", description: "المساعد الكيميائي" },
  { command: "weather", description: "الطقس" },
  { command: "pricelist", description: "قائمة أسعار الشركات" }
];

async function installGroupOwnerCommandMenus(chatId, creatorId) {
  const owners = [...new Set([MASTER_ID, Number(creatorId)])].filter(id => Number.isSafeInteger(id) && id > 0);
  const failures = [];
  for (const userId of owners) {
    try {
      if (userId !== Number(creatorId)) {
        let member;
        try { member = await bot.telegram.getChatMember(chatId, userId); }
        catch (error) {
          console.log("[COMMAND_MENU_OWNER_SCOPE] chat=" + chatId + " user=" + userId + " status=skipped_member_lookup");
          continue;
        }
        const present = ["creator", "administrator", "member"].includes(member?.status) || (member?.status === "restricted" && member?.is_member === true);
        if (!present) continue;
      }
      await bot.telegram.setMyCommands(GROUP_COMMANDS, { scope: { type: "chat_member", chat_id: chatId, user_id: userId } });
      console.log("[COMMAND_MENU_OWNER_SCOPE] chat=" + chatId + " user=" + userId + " status=ok");
    } catch (error) {
      console.warn("[COMMAND_MENU_OWNER_SCOPE_FAILED] chat=" + chatId + " user=" + userId + " code=" + (error?.code || "unknown") + " message=" + redactString(error?.message || "Telegram API error"));
      failures.push({ userId, error });
    }
  }
  return failures;
}
async function configureCommandMenus() {
  // Old builds installed narrower scopes that override all_private_chats/all_group_chats.
  // Clear those legacy scopes first so Telegram can display the new service-only menus.
  const failures = [];
  const clearScope = async (name, scope) => {
    try {
      await bot.telegram.deleteMyCommands({ scope });
      console.log(`[COMMAND_MENU_CLEAR] scope=${name} status=ok`);
    } catch (error) {
      console.warn(`[COMMAND_MENU_CLEAR_FAILED] scope=${name} code=${error?.code || "unknown"} message=${redactString(error?.message || "Telegram API error")}`);
      failures.push({ name: `clear:${name}`, error });
    }
  };
  await clearScope("all_chat_administrators", { type: "all_chat_administrators" });
  await clearScope("all_group_chats", { type: "all_group_chats" });

  const owners = [...new Set([MASTER_ID, ...String(process.env.OWNER_ID || "")
    .split(",").map(value => Number(value.trim())).filter(value => Number.isSafeInteger(value) && value > 0)])];
  for (const userId of owners) {
    // Private-user overrides are chat scopes; chat_member scopes are only for group members.
    await clearScope(`private_chat:${userId}`, { type: "chat", chat_id: userId });
  }

  // Clear per-chat and per-chat-administrator overrides left by older builds.
  try {
    const groups = await db.query("SELECT chat_id, active FROM authorized_chats");
    for (const row of groups.rows || []) {
      const chatId = Number(row.chat_id);
      if (!Number.isSafeInteger(chatId) || chatId >= 0) continue;
      await clearScope(`group_chat:${chatId}`, { type: "chat", chat_id: chatId });
      await clearScope(`group_admins:${chatId}`, { type: "chat_administrators", chat_id: chatId });
      // A group creator may also have a stale private-chat override from older builds.
      try {
        const admins = await bot.telegram.getChatAdministrators(chatId);
        const creatorId = Number(admins.find(member => member.status === "creator")?.user?.id);
        if (Number.isSafeInteger(creatorId) && creatorId > 0 && !owners.includes(creatorId)) {
          owners.push(creatorId);
          await clearScope(`private_chat:${creatorId}`, { type: "chat", chat_id: creatorId });
        }
        if (row.active === true) failures.push(...(await installGroupOwnerCommandMenus(chatId, creatorId)));
      } catch (error) {
        console.warn(`[COMMAND_MENU_OWNER_DISCOVERY_FAILED] chat=${chatId} code=${error?.code || "unknown"}`);
      }
    }
  } catch (error) {
    console.warn(`[COMMAND_MENU_LEGACY_SCOPE_DISCOVERY_FAILED] message=${redactString(error?.message || "database query failed")}`);
    failures.push({ name: "clear:legacy_group_scopes", error });
  }

  // Keep group menus service-only to avoid competing with GroupHelpBot.
  const menus = [
    ["default", [], { type: "default" }],
    ["private", [
      { command: "settings", description: "إعدادات البوت وحالة الخدمات" },
      { command: "panel", description: "لوحة خدمات البوت" },
      { command: "chemical", description: "المساعد الكيميائي" },
      { command: "weather", description: "الطقس" },
      { command: "pricelist", description: "قائمة أسعار الشركات" },
      { command: "help", description: "مساعدة البوت" }
    ], { type: "all_private_chats" }],
  ];
  for (const [name, commands, scope] of menus) {
    try {
      await bot.telegram.setMyCommands(commands, { scope });
      console.log(`[COMMAND_MENU_SETUP] scope=${name} status=ok`);
    } catch (error) {
      const code = error?.code || "unknown";
      console.warn(`[COMMAND_MENU_SETUP_FAILED] scope=${name} code=${code} message=${redactString(error?.message || "Telegram API error")}`);
      failures.push({ name, error });
    }
  }
  if (failures.length) {
    const error = new Error(`Telegram command menu setup failed for scopes: ${failures.map(x => x.name).join(", ")}`);
    error.code = "COMMAND_MENU_SETUP_FAILED";
    error.failedScopes = failures.map(x => x.name);
    throw error;
  }
}


async function clearLegacyCommandScopesForAddedGroup(chatId, creatorId) {
  // Telegram command scopes belong to this bot token only; never affects GroupHelpBot.
  const scopes = [
    [`group_chat:${chatId}`, { type: "chat", chat_id: chatId }],
    [`group_admins:${chatId}`, { type: "chat_administrators", chat_id: chatId }]
  ];
  if (Number.isSafeInteger(Number(creatorId)) && Number(creatorId) > 0) {
    scopes.push([`private_chat:${creatorId}`, { type: "chat", chat_id: Number(creatorId) }]);
  }
  for (const [name, scope] of scopes) {
    try {
      await bot.telegram.deleteMyCommands({ scope });
      console.log(`[COMMAND_MENU_CLEAR_ON_GROUP_ADD] scope=${name} status=ok`);
    } catch (error) {
      console.warn(`[COMMAND_MENU_CLEAR_ON_GROUP_ADD_FAILED] scope=${name} code=${error?.code || "unknown"} message=${redactString(error?.message || "Telegram API error")}`);
    }
  }
  if (db.pool) {
    try {
      const authorization = await db.query("SELECT active FROM authorized_chats WHERE chat_id=$1", [chatId]);
      if (authorization.rows[0]?.active === true) await installGroupOwnerCommandMenus(chatId, creatorId);
    } catch (error) {
      console.warn("[COMMAND_MENU_OWNER_SCOPE_FAILED] chat=" + chatId + " code=" + (error?.code || "unknown") + " message=" + redactString(error?.message || "group authorization lookup failed"));
    }
  }
}

async function ensureDb() {
  if (!db.pool) throw new Error("DATABASE_URL غير مضبوط؛ لا يمكن تطبيق ترحيلات قاعدة البيانات بأمان");
  return runMigrations({ db, rootDir: __dirname });
}

bot.use(async (ctx, next) => {
  const m = messageData(ctx);
  // Ignore ordinary log-channel messages, but let callback queries reach their authorized handlers.
  // Review buttons live in the log channel; returning here silently swallowed every button press.
  if (!m.chatId || (isLogChat(m.chatId) && !ctx.callbackQuery)) return;
  const isMessageUpdate = Boolean(ctx.message || ctx.editedMessage || ctx.channelPost);
  if (isMessageUpdate && m.messageId) {
    await cacheMessage(db.pool, m).catch(e => console.warn("[CACHE_FAIL]", redactString(e?.message || "cache_error")));
    const incomingCommand = commandName(m.text);
    if (incomingCommand) {
      console.info(`[TELEGRAM_COMMAND_RECEIVED] command=${incomingCommand} chatId=${m.chatId} chatType=${m.chatType} userId=${m.userId} updateType=${ctx.updateType}`);
    }
  }
  if (isMessageUpdate && m.messageId) {
    try {
      if (!(await claimMessage(db.pool, { chatId: m.chatId, messageId: m.messageId, updateType: ctx.updateType }))) return;
    } catch (error) {
      // Do not silently drop an explicit command solely because message de-duplication is unavailable.
      if (!commandName(m.text)) throw error;
      console.error(`[TELEGRAM_COMMAND_DEDUPE_FAILED] command=${commandName(m.text)} chatId=${m.chatId} code=${error?.code || "unknown"} message=${redactString(error?.message || "dedupe failed")}`);
    }
  }
  return next();
});

bot.on("my_chat_member", async ctx => {
  const u = ctx.myChatMember;
  const chat = u?.chat;
  const nextStatus = u?.new_chat_member?.status;
  const previousStatus = u?.old_chat_member?.status || "unknown";
  console.info(`[TELEGRAM_MY_CHAT_MEMBER] chatId=${chat?.id ?? "unknown"} chatType=${chat?.type ?? "unknown"} oldStatus=${previousStatus} newStatus=${nextStatus ?? "unknown"} actor=${u?.from?.id ?? "unknown"}`);
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
  // Remove only Borsa's stale Telegram menu overrides when it is added to a group.
  // GroupHelpBot has its own bot token and command scopes, so it is not modified.
  await clearLegacyCommandScopesForAddedGroup(chat.id, creatorId);

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
  if (!["member", "administrator"].includes(previousStatus)) {
    try {
      await ctx.telegram.sendMessage(MASTER_ID,
        `طلب اعتماد مجموعة جديدة\nاسم المجموعة: ${chat.title || "غير متاح"}\nالمعرّف: ${chat.id}\nمنشئ المجموعة: ${creatorId || "تعذر تحديده"}\nللموافقة أرسل في الخاص: /approvechat ${chat.id}`);
      console.info(`[GROUP_APPROVAL_OWNER_NOTIFIED] chatId=${chat.id} ownerUserId=${creatorId ?? "unknown"}`);
    } catch (error) {
      console.warn(`[GROUP_APPROVAL_OWNER_NOTIFY_FAILED] chatId=${chat.id} code=${error?.code || "unknown"} message=${redactString(error?.message || "Telegram notification failed")}`);
    }
  }
  await sendLog({ module: "security", stage: "group_approval_required", severity: "warn", status: "pending", details: { chatId: chat.id, actor, ownerUserId: creatorId, chatType: chat.type } });
});

// Monitor ordinary text and captioned photos through the same silent price-monitor path.
bot.on(["text", "photo"], async ctx => {
  const m = messageData(ctx);
  if (!["group", "supergroup", "private"].includes(m.chatType)) return;
  if (isBotMessage(ctx, botUserId)) return;
  const text = m.text;
  const cmd = commandName(text);
  const args = commandText(text);
  if (cmd === "priceedit" && m.chatType === "private") {
    if (!(await isPriceReviewer(ctx.telegram, m.userId))) { await ctx.reply("هذا الإجراء متاح للمراجعين المعتمدين ومالكي المجموعات النشطة المعتمدة فقط."); return; }
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
      // The database transaction has committed. Failures while refreshing the Telegram
      // log message must not be reported as if saving the price itself had failed.
      let buttonsRemoved = false;
      try {
        const queue = await db.query("SELECT log_chat_id, log_message_id FROM price_review_queue WHERE observation_id=$1", [id]);
        const target = queue.rows[0];
        if (target?.log_chat_id && target?.log_message_id) {
          try {
            await ctx.telegram.editMessageText(target.log_chat_id, target.log_message_id, undefined,
              `✏️ تم تعديل واعتماد سجل السعر #${id}\nالصنف: ${productText}\nالسعر: ${price.toFixed(2)} ج.م\nنوع السعر: جملة\nالمراجع: ${m.userId}`,
              { reply_markup: { inline_keyboard: [] } });
            buttonsRemoved = true;
          } catch (editError) {
            await sendLog({ module: "price-monitor", stage: "review_edit_clear_buttons", severity: "warn", status: "failed", details: { observationId: id, error: redactString(editError?.message || "could not clear review buttons") } }).catch(() => {});
          }
        }
      } catch (postSaveError) {
        await sendLog({ module: "price-monitor", stage: "review_edit_refresh_message", severity: "warn", status: "failed", details: { observationId: id, error: redactString(postSaveError?.message || "could not refresh review message") } }).catch(() => {});
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
    console.info(`[GROUP_CLAIM_RECEIVED] chatId=${m.chatId} chatType=${m.chatType} actor=${m.userId}`);
    try {
      const admins = await ctx.telegram.getChatAdministrators(m.chatId);
      const creator = admins.find(a => a.status === "creator")?.user;
      console.info(`[GROUP_CLAIM_CREATOR_CHECK] chatId=${m.chatId} actor=${m.userId} creatorId=${creator?.id ?? "unknown"} matches=${Boolean(creator && String(creator.id) === String(m.userId))}`);
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
      try {
        await ctx.telegram.sendMessage(MASTER_ID, `طلب اعتماد مجموعة جديدة\nالمعرّف: ${m.chatId}\nمنشئ المجموعة: ${creator.id}\nللموافقة أرسل في الخاص: /approvechat ${m.chatId}`);
        console.info(`[GROUP_CLAIM_OWNER_NOTIFIED] chatId=${m.chatId} ownerUserId=${creator.id}`);
      } catch (notifyError) {
        console.warn(`[GROUP_CLAIM_OWNER_NOTIFY_FAILED] chatId=${m.chatId} code=${notifyError?.code || "unknown"} message=${redactString(notifyError?.message || "Telegram notification failed")}`);
      }
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
  if (cmd === "panel" && m.chatType === "private") {
    if (!isMaster(m.userId)) {
      await ctx.reply("لوحة الخدمات الخاصة متاحة لمالك البوت فقط.");
      return;
    }
    await ctx.reply(adminPanel.panelText(APP_VERSION, ai.providers || []), {
      reply_markup: adminPanel.privatePanelKeyboard()
    });
    return;
  }

  if (cmd === "settings" && ["private", "group", "supergroup"].includes(m.chatType)) {
    try {
      if (m.chatType === "private" && isMaster(m.userId)) {
        const settings = await serviceSettings.getSettings(db.pool, "global", 0);
        await ctx.reply(adminPanel.settingsText("global", null, settings), { reply_markup: adminPanel.settingsKeyboard(settings, "global") });
        return;
      }
      if (m.chatType === "private") {
        const groups = await serviceSettings.listOwnedGroups(db.pool, m.userId);
        if (!groups.length) { await ctx.reply("إعدادات الخاص متاحة لمالك البوت أو منشئ مجموعة معتمدة فقط."); return; }
        const rows = groups.map(group => [{ text: "⚙️ إعدادات المجموعة " + group.chat_id, callback_data: "owner:group:" + group.chat_id }]);
        await ctx.reply("اختر المجموعة التي تريد إدارة خدماتها:", { reply_markup: { inline_keyboard: rows } });
        return;
      }
      if (!(await isAuthorizedChat(m.chatId)) || !(await canManage(ctx.telegram, m.chatId, m.userId))) {
        await ctx.reply("هذا الأمر متاح لمالك البوت أو منشئ هذه المجموعة المعتمدة فقط.");
        return;
      }
      const settings = await serviceSettings.getSettings(db.pool, "group", m.chatId);
      await ctx.reply(adminPanel.settingsText("group", m.chatId, settings), { reply_markup: adminPanel.settingsKeyboard(settings, "group", m.chatId) });
    } catch (error) {
      await ctx.reply("تعذر تحميل إعدادات الخدمات من قاعدة البيانات. لم يتم تغيير أي إعداد.");
      await sendLog({ module: "admin-panel", stage: "settings_load", severity: "warn", status: "failed", details: { error: redactString(error?.message || "settings load failed") } }).catch(() => {});
    }
    return;
  }

  if (m.chatType !== "private" && !(await isAuthorizedChat(m.chatId))) return;

  // Long pasted catalogs are handled explicitly with /قائمة; keep them out of per-message AI and review alerts.
  if (!cmd && priceMonitor.isBulkPriceList(text || m.caption || "")) return;

  // Ordinary members may use automatic services, but slash commands are controller-only.
  const isChemicalCommand = ["مساعد", "كيمياء", "المساعد_الكيميائي", "chemical", "chem"].includes(cmd);
  if (cmd === "start" || cmd === "help") {
    await ctx.reply("مرحبًا بك في بوت بورصة المنظفات. الخدمات المتاحة: /chemical للمساعد الكيميائي و/weather للطقس، أو استخدم أمر قائمة الأسعار داخل المجموعة المعتمدة.");
    return;
  }

  if (cmd === "قائمة" || cmd === "pricelist") {
    const authorizedListOperator = isMaster(m.userId) || (["group", "supergroup"].includes(m.chatType) && await ctx.telegram.getChatMember(m.chatId, m.userId).then(member => ["administrator", "creator"].includes(member.status)).catch(() => false));
    if (!authorizedListOperator) { await ctx.reply("هذا الأمر متاح لمشرفي المجموعة ومالك البوت فقط."); return; }
    if (!(await serviceSettings.isServiceEnabled(db.pool, "lists", m.chatId))) { await ctx.reply("خدمة قوائم الشركات متوقفة لهذه المجموعة حاليًا."); return; }
    let sourceText = args;
    const parsedLinks = parseMessageLinks(args);
    if (parsedLinks.invalidCount > 0 || parsedLinks.links.length > 2) {
      await ctx.reply("أرسل رابط رسالة واحدًا أو رابطين صحيحين فقط بعد الأمر /قائمة.");
      return;
    }
    if (parsedLinks.links.length) {
      const lookups = await Promise.all(parsedLinks.links.map(link => findCachedLinkedMessage({
        pool: db.pool,
        telegram: ctx.telegram,
        link,
        getMessageByRef
      })));
      const missingIndex = lookups.findIndex(result => !result.message);
      if (missingIndex >= 0) {
        const reason = lookups[missingIndex].status === "chat_unavailable"
          ? "لم أتمكن من الوصول إلى إحدى القنوات أو المجموعات من خلال البوت."
          : "إحدى الرسائل المرتبطة غير محفوظة في ذاكرة البوت السابقة.";
        await ctx.reply(`🔎 ${reason}\nأعد توجيه الرسالتين المطلوبتين إلى هنا، أو أرسل نص القائمة بعد الأمر /قائمة.`);
        return;
      }
      // Treat both linked posts as one source catalog before parsing, saving, and rendering.
      sourceText = lookups.map(result => result.message.text || result.message.caption || "").filter(Boolean).join("\n");
    }
    if (!sourceText || !isListLike(sourceText)) {
      await ctx.reply("لم أجد قائمة أسعار مكتملة بما يكفي. أرسل النص تحت /قائمة أو أرسل رابط رسالة سبق أن رآها البوت.");
      return;
    }
    const parsedList = await extractList(ai, sourceText, { timeoutMs: 8000 });
    const rows = Array.isArray(parsedList.items) ? parsedList.items : deterministicList(sourceText);
    const accepted = rows.filter(r => r.decision === "accepted");
    if (db.pool) {
      await db.withTransaction(client => persistPriceList(client, {
        message: m, sourceText, parsedList, rows
      }));
    }
    await sendLog({ module: "price-list", stage: "processed", status: "ok", details: { actor: m.userId, extracted: rows.length, accepted: accepted.length, method: parsedList.method, company: parsedList.company || null } });
    const companyNames = [...new Set(accepted.map(row => String(row.company || parsedList.company || "").trim()).filter(Boolean))];
    if (accepted.length >= 3 && companyNames.length === 1 && typeof ctx.replyWithPhoto === "function") {
      try {
        const images = await renderPriceListImages({ company: companyNames[0], items: accepted, watermark: "بورصة المنظفات لأصحاب المحلات", month: parsedList.month || null, priceType: parsedList.priceType || "أسعار جملة", logoPlacement: "both" });
        const caption = `📋 قائمة أسعار ${companyNames[0]}\n${parsedList.month ? `الفترة: ${parsedList.month}\n` : ""}${parsedList.priceType || "أسعار جملة"}\nالأصناف المنشورة: ${accepted.length}\nعدد الصور: ${images.length}\n${BOT_CREDIT}`;
        if (typeof ctx.replyWithMediaGroup === "function" && images.length > 1) {
          // Telegram media groups accept at most 10 photos. Batch longer catalogs
          // so expanding the row limit cannot make publication fail at Telegram's API.
          for (let offset = 0; offset < images.length; offset += 10) {
            const batch = images.slice(offset, offset + 10);
            if (batch.length > 1) {
              await ctx.replyWithMediaGroup(batch.map((image, i) => ({
                type: "photo",
                media: { source: image, filename: `borsa-price-list-${offset + i + 1}.png` },
                ...(offset === 0 && i === 0 ? { caption } : {})
              })));
            } else {
              await ctx.replyWithPhoto(
                { source: batch[0], filename: `borsa-price-list-${offset + 1}.png` },
                { caption: offset === 0 ? caption : `صفحة ${offset + 1} من ${images.length}` }
              );
            }
          }
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
    if (!(await serviceSettings.isServiceEnabled(db.pool, "chemical", m.chatId))) { await ctx.reply("المساعد الكيميائي متوقف لهذه المجموعة حاليًا."); return; }
    if (!["group", "supergroup"].includes(m.chatType)) return;
    const question = await chemical.resolveConversationInput(db.pool, ctx.message, args || "اكتب سؤالك الكيميائي بوضوح.");
    const answer = await chemical.answer(chemicalAI, question, error => log({ module: "chemical-assistant", stage: `${error?.aiProvider || "provider_unknown"}_request`, severity: "error", status: "safe_fallback", input: question, details: { provider: error?.aiProvider || "unknown", message: error?.message || "AI provider request failed" } }), chemicalFallbackAI);
    const links = buildChemicalLinks(question);
    const mention = ctx.from?.username ? `@${ctx.from.username}\n` : "";
    const body = `🧪 المساعد الكيميائي\n\n${mention}${require("./core/links").escapeHtml(answer)}${renderChemicalLinks(links) ? `\n\n${renderChemicalLinks(links)}` : ""}\n\nأهل الخبرة في الجروب، نرحب بمشاركاتكم وتجاربكم الفنية المرتبطة بالسؤال.`;
    const sent = await ctx.reply(body, { reply_to_message_id: m.messageId, parse_mode: "HTML", disable_web_page_preview: true });
    await chemical.saveConversationContext(db.pool, { chatId: m.chatId, assistantMessageId: sent?.message_id, contextText: question })
      .catch(error => sendLog({ module: "chemical-assistant", stage: "conversation_context_save", severity: "warn", status: "failed", details: { chatId: m.chatId, error: redactString(error?.message || "context save failed") } }).catch(() => {}));
    return;
  }

  if (cmd === "weather" || cmd === "الطقس") {
    if (!(await serviceSettings.isServiceEnabled(db.pool, "weather", m.chatId))) { await ctx.reply("خدمة الطقس متوقفة لهذه المجموعة حاليًا."); return; }
    const city = args || "القاهرة";
    const result = await weather.getWeatherSummary(ai, city);
    await ctx.reply(`${result.message}${result.ok ? "" : `\n🔎 بحث الطقس: ${result.searchUrl}`}`, { disable_web_page_preview: true });
    return;
  }

  if (cmd) return; // commands are intentionally invisible/unusable to unauthorized users

  if (!priceMonitor.isEligibleMessage({ chatType: m.chatType, text: text || m.caption || "", isLogChannel: false, isCommand: false, ownMessage: isBotMessage(ctx, botUserId) })) return;
  const pricesEnabled = await serviceSettings.isServiceEnabled(db.pool, "prices", m.chatId);
  const merchantsEnabled = await serviceSettings.isServiceEnabled(db.pool, "merchants", m.chatId);

  let merchantId = null;
  // Use captions too: sellers frequently attach the price and phone number to a photo.
  const merchantSourceText = text || m.caption || "";
  const phone = merchantSourceText.match(/(?:\+?20|0)?1\d{9,10}/)?.[0];
  if (phone && /(سعر|جنيه|ج\s|مسحوق|جيل|منظف|تاجر|محل)/i.test(merchantSourceText)) {
    try {
      const saved = await saveMerchant(db.pool, {
        name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "تاجر غير مسمى",
        activity: "مرصد أسعار",
        location: "غير محدد",
        phone,
        telegram_username: ctx.from?.username || null,
      }, { chatId: m.chatId, messageId: m.messageId, userId: m.userId, rawText: merchantSourceText });
      merchantId = saved.merchant?.id || null;
      if (saved.saved) await sendLog({ module: "merchant", stage: saved.updated ? "updated" : "new", status: "ok", details: { merchantId, name: saved.merchant?.name } });
    } catch (e) { await sendLog({ module: "merchant", stage: "save", severity: "error", status: "failed", details: { error: e.message } }); }
  }

  // Silent price observation runs independently of AI intent classification.
  // A classification miss must never prevent a plausible price from being recorded.
  if (pricesEnabled) {
  try {
    const result = await priceMonitor.observe({ pool: db.pool, message: m, merchantId, registry, requireCatalogMatch: true });
    if (result.saved > 0) {
      // Match each accepted live observation to the latest compatible official company reference.
      // Comparison failures are logged but must never discard an already-saved group observation.
      for (const item of result.savedRows) {
        if (item.row.decision !== "accepted") continue;
        try {
          const comparison = await priceReferenceComparison.persistObservationReferenceComparison(db.pool, item.id, item.row);
          if (comparison.comparable) {
            await sendLog({
              module: "price-monitor",
              stage: "reference_comparison",
              status: "ok",
              details: {
                observationId: item.id,
                referenceObservationId: comparison.referenceObservationId,
                company: comparison.companyLabel,
                sourcePeriod: comparison.sourcePeriod,
                referencePrice: comparison.referencePrice,
                observedPrice: comparison.observedPrice,
                difference: comparison.difference,
                differencePercent: comparison.differencePercent,
                direction: comparison.direction
              }
            });
          }
        } catch (comparisonError) {
          await sendLog({
            module: "price-monitor",
            stage: "reference_comparison",
            severity: "warn",
            status: "failed",
            details: { observationId: item.id, error: redactString(comparisonError?.message || "reference comparison failed") }
          }).catch(() => {});
        }
      }
      const pendingRows = result.savedRows.filter(item => item.row.decision === "pending");
      for (const item of pendingRows) {
        if (isTelegramRateLimitedNow()) break;
        let sentReviewMessage = null;
        try {
          await db.query(
            `INSERT INTO price_review_queue(observation_id, source_chat_id, log_chat_id)
             VALUES($1,$2,$3) ON CONFLICT(observation_id) DO NOTHING`,
            [item.id, m.chatId || null, LOG_CHAT_ID]
          );
          const claimToken = require("node:crypto").randomUUID();
          const claimed = await db.query(
            `UPDATE price_review_queue SET notification_claim_token=$1, notification_claimed_at=NOW()
              WHERE observation_id=$2 AND status='pending' AND log_message_id IS NULL
                AND (notification_claimed_at IS NULL OR notification_claimed_at < NOW() - INTERVAL '120 seconds')
              RETURNING observation_id`,
            [claimToken, item.id]
          );
          if (!claimed.rowCount) continue;
          sentReviewMessage = await bot.telegram.sendMessage(LOG_CHAT_ID, priceReview.formatReviewMessage(item.id, item.row), {
            reply_markup: priceReview.reviewKeyboard(item.id), disable_web_page_preview: true
          });
          const saved = await db.query(
            `UPDATE price_review_queue SET log_message_id=$1, notification_claim_token=NULL, notification_claimed_at=NULL
              WHERE observation_id=$2 AND status='pending' AND log_message_id IS NULL AND notification_claim_token=$3
              RETURNING observation_id`,
            [sentReviewMessage.message_id, item.id, claimToken]
          );
          if (!saved.rowCount) throw new Error("price_review_notification_save_conflict");
        } catch (reviewError) {
          const hitTelegramRateLimit = isTelegramRateLimit(reviewError);
          if (hitTelegramRateLimit) markTelegramRateLimited(reviewError);
          // Telegram may have accepted the message even if saving its ID failed.
          // Best-effort deletion prevents a stale actionable message being duplicated by startup recovery.
          if (sentReviewMessage?.message_id != null) {
            try { await bot.telegram.deleteMessage(LOG_CHAT_ID, sentReviewMessage.message_id); } catch {}
          }
          await sendLog({ module: "price-monitor", stage: "review_notification", severity: "warn", status: "failed", details: { observationId: item.id, error: redactString(reviewError?.message || "review notification failed") } });
          if (hitTelegramRateLimit) break;
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

  }

  // In approved groups, automatically answer likely chemistry questions once per incoming message.
  const chemicalInput = await chemical.resolveConversationInput(db.pool, ctx.message, text);
  if (ctx.message && ["group", "supergroup"].includes(m.chatType) && chemical.isChemicalQuestion(chemicalInput) && (await serviceSettings.isServiceEnabled(db.pool, "chemical", m.chatId))) {
    const answer = await chemical.answer(chemicalAI, chemicalInput, error => log({ module: "chemical-assistant", stage: `${error?.aiProvider || "provider_unknown"}_request`, severity: "error", status: "safe_fallback", input: chemicalInput, details: { provider: error?.aiProvider || "unknown", message: error?.message || "AI provider request failed" } }), chemicalFallbackAI);
    const links = buildChemicalLinks(chemicalInput);
    const body = `🧪 المساعد الكيميائي\n\n${ctx.from?.username ? `@${ctx.from.username}\n` : ""}${require("./core/links").escapeHtml(answer)}${renderChemicalLinks(links) ? `\n\n${renderChemicalLinks(links)}` : ""}\n\nأهل الخبرة في الجروب، نرحب بمشاركاتكم وتجاربكم الفنية المرتبطة بالسؤال.`;
    const sent = await ctx.reply(body, { reply_to_message_id: m.messageId, parse_mode: "HTML", disable_web_page_preview: true });
    await chemical.saveConversationContext(db.pool, { chatId: m.chatId, assistantMessageId: sent?.message_id, contextText: chemicalInput })
      .catch(error => sendLog({ module: "chemical-assistant", stage: "conversation_context_save", severity: "warn", status: "failed", details: { chatId: m.chatId, error: redactString(error?.message || "context save failed") } }).catch(() => {}));
    return;
  }


});


bot.action(/^group-settings:(refresh|close|toggle:[a-z]+)$/, async ctx => {
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (!["group", "supergroup"].includes(ctx.callbackQuery?.message?.chat?.type) ||
      !(await isAuthorizedChat(chatId)) || !(await canManage(ctx.telegram, chatId, ctx.from?.id))) {
    await ctx.answerCbQuery("إعدادات هذه المجموعة متاحة لمنشئها فقط.", { show_alert: true }).catch(() => {});
    return;
  }
  try {
    const action = ctx.match[1];
    if (action === "close") {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.answerCbQuery("تم إغلاق إعدادات الخدمات.").catch(() => {});
      return;
    }
    if (action.startsWith("toggle:")) {
      const key = action.slice(7);
      const current = await serviceSettings.getSettings(db.pool, "group", chatId);
      const item = current.find(value => value.key === key);
      if (!item) throw new Error("UNKNOWN_SERVICE_SETTING");
      await serviceSettings.setServiceSetting(db.pool, { scope: "group", chatId, serviceKey: key, enabled: !item.enabled, actorId: ctx.from.id });
    }
    const settings = await serviceSettings.getSettings(db.pool, "group", chatId);
    await ctx.editMessageText(adminPanel.settingsText("group", chatId, settings), { reply_markup: adminPanel.settingsKeyboard(settings, "group", chatId) });
    await ctx.answerCbQuery(action.startsWith("toggle:") ? "تم حفظ إعداد المجموعة." : "").catch(() => {});
  } catch (error) {
    await ctx.answerCbQuery("تعذر حفظ الإعداد.", { show_alert: true }).catch(() => {});
    await sendLog({ module: "admin-panel", stage: "group_settings_callback", severity: "warn", status: "failed", details: { chatId, error: redactString(error?.message || "group settings callback failed") } }).catch(() => {});
  }
});

bot.action(/^panel:(home|chemical|prices|lists|merchants|deals|weather|reports|health|diagnostics|settings|groups|toggle:[a-z]+|group:-?\d+|group-toggle:-?\d+:[a-z]+)$/, async ctx => {
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (ctx.callbackQuery?.message?.chat?.type !== "private" || !isMaster(ctx.from?.id)) {
    await ctx.answerCbQuery("هذه اللوحة متاحة لمالك البوت في الخاص فقط.", { show_alert: true }).catch(() => {});
    return;
  }
  const section = ctx.match[1];
  try {
    if (section === "settings" || section.startsWith("toggle:")) {
      if (section.startsWith("toggle:")) {
        const key = section.slice(7);
        const current = await serviceSettings.getSettings(db.pool, "global", 0);
        const item = current.find(value => value.key === key);
        if (!item) throw new Error("UNKNOWN_SERVICE_SETTING");
        await serviceSettings.setServiceSetting(db.pool, { scope: "global", serviceKey: key, enabled: !item.enabled, actorId: ctx.from.id });
      }
      const settings = await serviceSettings.getSettings(db.pool, "global", 0);
      await ctx.editMessageText(adminPanel.settingsText("global", null, settings), { reply_markup: adminPanel.settingsKeyboard(settings, "global") });
      await ctx.answerCbQuery(section.startsWith("toggle:") ? "تم حفظ الإعداد وتطبيقه." : "").catch(() => {});
      return;
    }
    if (section === "groups") {
      const groups = await serviceSettings.listAuthorizedGroups(db.pool);
      const rows = groups.map(group => [{ text: "👥 " + group.chat_id, callback_data: "panel:group:" + group.chat_id }]);
      rows.push([{ text: "⬅️ القائمة الرئيسية", callback_data: "panel:home" }]);
      await ctx.editMessageText(groups.length ? "المجموعات المعتمدة — اختر مجموعة لإدارة خدماتها:" : "لا توجد مجموعات معتمدة حاليًا.", { reply_markup: { inline_keyboard: rows } });
      await ctx.answerCbQuery().catch(() => {});
      return;
    }
    if (section.startsWith("group:") || section.startsWith("group-toggle:")) {
      const parts = section.split(":");
      const targetChatId = Number(parts[1]);
      const groups = await serviceSettings.listAuthorizedGroups(db.pool);
      if (!groups.some(group => Number(group.chat_id) === targetChatId)) throw new Error("GROUP_NOT_AUTHORIZED");
      if (section.startsWith("group-toggle:")) {
        const key = parts[2];
        const current = await serviceSettings.getSettings(db.pool, "group", targetChatId);
        const item = current.find(value => value.key === key);
        if (!item) throw new Error("UNKNOWN_SERVICE_SETTING");
        await serviceSettings.setServiceSetting(db.pool, { scope: "group", chatId: targetChatId, serviceKey: key, enabled: !item.enabled, actorId: ctx.from.id });
      }
      const settings = await serviceSettings.getSettings(db.pool, "group", targetChatId);
      await ctx.editMessageText(adminPanel.settingsText("group", targetChatId, settings), { reply_markup: adminPanel.settingsKeyboard(settings, "admin-group", targetChatId) });
      await ctx.answerCbQuery(section.startsWith("group-toggle:") ? "تم حفظ إعداد المجموعة." : "").catch(() => {});
      return;
    }
    let body;
    if (section === "home") body = adminPanel.panelText(APP_VERSION, ai.providers || []);
    else if (section === "merchants") {
      const count = await db.query("SELECT COUNT(*)::int AS count FROM merchants");
      body = "🏪 قاعدة بيانات التجار\n\nعدد التجار المحفوظين: " + (count.rows[0]?.count ?? 0) + "\n\nالحفظ تلقائي وليس ردًا ظاهرًا في المجموعة.";
    } else if (section === "prices") {
      const count = await db.query("SELECT COUNT(*)::int AS count FROM price_observations");
      body = "💰 مرصد الأسعار\n\nإجمالي ملاحظات الأسعار المسجلة: " + (count.rows[0]?.count ?? 0) + "\n\nيعمل المرصد بصمت ويحول السجلات غير الواثقة للمراجعة.";
    } else if (section === "chemical") body = "🧪 المساعد الكيميائي\n\nيستخدم Gemini أولًا ثم مزودي الاحتياط المضبوطين عند الحاجة.";
    else if (section === "lists") body = "📋 قوائم الشركات\n\nأرسل /قائمة متبوعًا بنص قائمة الأسعار.";
    else if (section === "deals") body = "🛍️ العروض والنشرات\n\nإعدادات التشغيل موجودة في إعدادات الخدمات. لا يطلق هذا الزر عملية scraping مدفوعة.";
    else if (section === "weather") body = "🌦️ الطقس\n\nإعدادات الخدمة والنشرة موجودة في إعدادات الخدمات.";
    else if (section === "reports") body = "📊 التقارير\n\nأحداث الحفظ والمراجعة والأخطاء تظهر في قناة السجل المشتركة.";
    else if (section === "health") body = "🩺 حالة الخدمات\n\nاتصال قاعدة البيانات: " + (db.pool ? "مهيأ" : "غير متاح") + "\nمزودو الذكاء: " + ((ai.providers || []).join("، ") || "لا يوجد") + "\nالإصدار: " + APP_VERSION;
    else body = "📄 التشخيص\n\nراجع قناة السجل للتقارير التشغيلية.";
    await ctx.editMessageText(body, { reply_markup: section === "home" ? adminPanel.privatePanelKeyboard() : adminPanel.actionKeyboard() });
    await ctx.answerCbQuery().catch(() => {});
  } catch (error) {
    await ctx.answerCbQuery("تعذر تنفيذ الإجراء أو تحميل الإعدادات.", { show_alert: true }).catch(() => {});
    await sendLog({ module: "admin-panel", stage: "callback", severity: "warn", status: "failed", details: { section, error: redactString(error?.message || "panel callback failed") } }).catch(() => {});
  }
});

bot.action(/^owner:group:(-?\d+)$/, async ctx => {
  const targetChatId = Number(ctx.match[1]);
  const groups = await serviceSettings.listOwnedGroups(db.pool, ctx.from.id);
  if (!groups.some(group => Number(group.chat_id) === targetChatId)) {
    await ctx.answerCbQuery("هذه المجموعة ليست ضمن صلاحياتك.", { show_alert: true }).catch(() => {});
    return;
  }
  const settings = await serviceSettings.getSettings(db.pool, "group", targetChatId);
  const rows = settings.map(item => [{ text: (item.enabled ? "🟢 " : "🔴 ") + item.label, callback_data: "owner:toggle:" + targetChatId + ":" + item.key }]);
  rows.push([{ text: "⬅️ رجوع", callback_data: "owner:back" }]);
  await ctx.editMessageText(adminPanel.settingsText("group", targetChatId, settings), { reply_markup: { inline_keyboard: rows } });
  await ctx.answerCbQuery().catch(() => {});
});
bot.action(/^owner:toggle:(-?\d+):([a-z]+)$/, async ctx => {
  const targetChatId = Number(ctx.match[1]), key = ctx.match[2];
  const groups = await serviceSettings.listOwnedGroups(db.pool, ctx.from.id);
  if (!groups.some(group => Number(group.chat_id) === targetChatId)) {
    await ctx.answerCbQuery("هذه المجموعة ليست ضمن صلاحياتك.", { show_alert: true }).catch(() => {});
    return;
  }
  const current = await serviceSettings.getSettings(db.pool, "group", targetChatId);
  const item = current.find(value => value.key === key);
  if (!item) { await ctx.answerCbQuery("إعداد غير معروف.", { show_alert: true }).catch(() => {}); return; }
  await serviceSettings.setServiceSetting(db.pool, { scope: "group", chatId: targetChatId, serviceKey: key, enabled: !item.enabled, actorId: ctx.from.id });
  const updated = await serviceSettings.getSettings(db.pool, "group", targetChatId);
  const rows = updated.map(value => [{ text: (value.enabled ? "🟢 " : "🔴 ") + value.label, callback_data: "owner:toggle:" + targetChatId + ":" + value.key }]);
  rows.push([{ text: "⬅️ رجوع", callback_data: "owner:back" }]);
  await ctx.editMessageText(adminPanel.settingsText("group", targetChatId, updated), { reply_markup: { inline_keyboard: rows } });
  await ctx.answerCbQuery("تم حفظ إعداد المجموعة.").catch(() => {});
});
bot.action("owner:back", async ctx => {
  const groups = await serviceSettings.listOwnedGroups(db.pool, ctx.from.id);
  const rows = groups.map(group => [{ text: "⚙️ " + group.chat_id, callback_data: "owner:group:" + group.chat_id }]);
  await ctx.editMessageText("اختر المجموعة التي تريد إدارة خدماتها:", { reply_markup: { inline_keyboard: rows } });
  await ctx.answerCbQuery().catch(() => {});
});
bot.action(/^prv:(approve|new|ignore):(\d+)$/, async ctx => {
  // Stop Telegram's callback spinner before database and administrator API checks.
  await ctx.answerCbQuery("جارٍ التحقق من الصلاحية...").catch(() => {});
  if (!isLogChat(ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id) || !(await isPriceReviewer(ctx.telegram, ctx.from?.id))) {
    await sendLog({ module: "price-monitor", stage: "review_action_unauthorized", severity: "warn", status: "blocked", details: { userId: ctx.from?.id, action: ctx.match?.[1], observationId: ctx.match?.[2] } }).catch(() => {});
    return;
  }
  const action = ctx.match[1], id = Number(ctx.match[2]);
  let resolved = false;
  try {
    const result = await priceReview.resolveReview({ db, id, action, reviewerId: ctx.from.id });
    if (!result.ok) {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
      return;
    }
    resolved = true;
    const status = action === "ignore" ? "🚫 تم التجاهل" : action === "new" ? "🆕 تم اعتماد السعر والصنف الجديد" : "✅ تم اعتماد السعر";
    const original = ctx.callbackQuery.message?.text || `مراجعة السعر #${id}`;
    await ctx.editMessageText(`${original}\n\n${status} — بواسطة المسؤول ${ctx.from.id}`, { reply_markup: { inline_keyboard: [] } });
  } catch (error) {
    if (resolved) await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await sendLog({ module: "price-monitor", stage: "review_action", severity: "error", status: "failed", details: { observationId: id, action, error: redactString(error?.message || "review action failed") } });
  }
});

bot.action(/^prv:edit:(\d+)$/, async ctx => {
  // Acknowledge immediately so Telegram does not leave the button spinning while access is checked.
  await ctx.answerCbQuery("جارٍ التحقق من الصلاحية...").catch(() => {});
  if (!isLogChat(ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id) || !(await isPriceReviewer(ctx.telegram, ctx.from?.id))) {
    await sendLog({ module: "price-monitor", stage: "review_edit_unauthorized", severity: "warn", status: "blocked", details: { userId: ctx.from?.id, observationId: ctx.match?.[1] } }).catch(() => {});
    return;
  }
  const id = Number(ctx.match[1]);
  let current = null;
  try {
    const found = await db.query(
      "SELECT product_text, package_sale_price, weight_g, volume_ml, pack_count FROM price_observations WHERE id=$1 AND decision='pending'",
      [id]
    );
    current = found.rows?.[0] || null;
  } catch (error) {
    await sendLog({ module: "price-monitor", stage: "review_edit_prefill_failed", severity: "warn", status: "fallback", details: { observationId: id, error: redactString(error?.message || "could not load current price fields") } }).catch(() => {});
  }
  const prompt = priceReview.formatPriceEditPrompt(id, current);
  try { await ctx.telegram.sendMessage(ctx.from.id, prompt); }
  catch (error) { await sendLog({ module: "price-monitor", stage: "review_edit_dm_failed", severity: "warn", status: "failed", details: { userId: ctx.from?.id, observationId: id, error: redactString(error?.message || "could not send private edit instructions") } }).catch(() => {}); }
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
  await chemical.ensureConversationContextSchema(db.pool);
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  const me = await bot.telegram.getMe();
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  botUserId = me.id;
  try {
    const recovered = await priceReviewRecovery.recoverPendingNotifications({
      db,
      telegram: bot.telegram,
      defaultLogChatId: LOG_CHAT_ID,
      onError: async (error, details) => {
        await sendLog({
          module: "price-monitor",
          stage: "review_notification_recovery",
          severity: "warn",
          status: "failed",
          details: { ...details, error: redactString(error?.message || "review recovery failed") }
        });
      }
    });
    if (recovered.found > 0) {
      console.log(`[PRICE_REVIEW_RECOVERY] found=${recovered.found} sent=${recovered.sent} failed=${recovered.failed}`);
    }
  } catch (error) {
    console.warn("[PRICE_REVIEW_RECOVERY_FAILED]", redactString(error?.message || "review recovery failed"));
    await sendLog({
      module: "price-monitor",
      stage: "review_notification_recovery",
      severity: "warn",
      status: "failed",
      details: { error: redactString(error?.message || "review recovery failed") }
    }).catch(() => {});
  }
  await configureCommandMenus().catch(error => sendLog({ module: "security", stage: "command_menu_setup", severity: "warn", status: "failed", details: { code: error.code || null, message: error.message } }));
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  console.log(`Borsa GBT Bot V1 Mona Lisa ${APP_VERSION} — @${me.username} — ${BOT_CREDIT}`);
  console.log(`AI providers configured: ${ai.providers.join(", ") || "none"}`);
  // Scheduled newsletters are enabled by default; set DEALS_SCHEDULER_ENABLED=false to pause them.
  if (String(process.env.DEALS_SCHEDULER_ENABLED ?? "true").toLowerCase() !== "false") {
    stopDeals = startDealScheduler({ pool: db.pool, telegram: bot.telegram,
      onDiagnostics: async details => {
        console.info("[DEALS_SOURCE_DIAGNOSTICS] " + JSON.stringify(details));
      },
      onError: async (error, details) => {
        const report = makeReport({ module: "deals", stage: details?.stage || "daily_cycle", severity: "ERROR", action: "deal_newsletter", error, details });
        await emitReport({ bot, db, report });
      }
    });
    console.log("[DEALS_SCHEDULER] Enabled by default unless DEALS_SCHEDULER_ENABLED=false. Scheduled scraping may consume paid credits.");
  } else {
    console.log("[DEALS_SCHEDULER] Disabled explicitly by DEALS_SCHEDULER_ENABLED=false.");
  }
  // Catalog notices target every active, approved group from authorized_chats.
  stopCatalogs = startCatalogNewsletterScheduler({
    pool: db.pool,
    telegram: bot.telegram,
    publishNotices: false,
    onError: async (error, details) => {
      const report = makeReport({ module: "catalog_newsletter", stage: details?.stage || "daily_check", severity: "ERROR", action: "catalog_newsletter", error, details });
      await emitReport({ bot, db, report });
    }
  });
  console.log("[CATALOG_NEWSLETTER_SCHEDULER] Daily check scheduled for 09:00 Africa/Cairo; targets active approved groups.");
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
  console.log("[ECONOMIC_NEWSLETTER_SCHEDULER] Daily bulletin scheduled for 10:00 Africa/Cairo; targets active approved groups.");
  await ensurePriceDigestSchema(db.pool);
  if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
  stopPriceDigest = startPriceDigestScheduler({
    pool: db.pool,
    telegram: bot.telegram,
    onError: async (error, details) => {
      const report = makeReport({ module: "price_digest", stage: details?.stage || "daily_cycle", severity: "ERROR", action: "daily_price_digest", error, details });
      await emitReport({ bot, db, report });
    }
  });
  console.log("[PRICE_DIGEST_SCHEDULER] Daily confirmed-price digest scheduled for 20:00 Africa/Cairo; targets active approved groups.");
  if (String(process.env.PRAYER_ALERTS_ENABLED ?? "true").toLowerCase() !== "false") {
    await ensurePrayerAlertsSchema(db.pool);
    if (shutdownRequested) { await shutdown("STARTUP_CANCELLED"); return; }
    stopPrayerAlerts = startPrayerAlertScheduler({
      pool: db.pool,
      telegram: bot.telegram,
      onError: async (error, details) => {
        const report = makeReport({ module: "prayer_alerts", stage: details?.stage || "daily_prayer_check", severity: "ERROR", action: "official_cairo_prayer_alert", error, details });
        await emitReport({ bot, db, report });
      }
    });
    console.log("[PRAYER_ALERT_SCHEDULER] Five daily Cairo prayer alerts use official Egyptian Survey Authority times; targets active approved groups.");
  } else {
    console.log("[PRAYER_ALERT_SCHEDULER_DISABLED] PRAYER_ALERTS_ENABLED=false; prayer alerts are disabled.");
  }
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
    try { stopDeals(); } catch (error) { console.error("[SHUTDOWN_DEALS_ERROR]", error?.message || error); }
    try { stopCatalogs(); } catch (error) { console.error("[SHUTDOWN_CATALOGS_ERROR]", error?.message || error); }
    try { stopWeather(); } catch (error) { console.error("[SHUTDOWN_WEATHER_ERROR]", error?.message || error); }
    try { stopEconomicNewsletter(); } catch (error) { console.error("[SHUTDOWN_ECONOMIC_NEWSLETTER_ERROR]", error?.message || error); }
    try { stopPriceDigest(); } catch (error) { console.error("[SHUTDOWN_PRICE_DIGEST_ERROR]", error?.message || error); }
    try { stopPrayerAlerts(); } catch (error) { console.error("[SHUTDOWN_PRAYER_ALERTS_ERROR]", error?.message || error); }
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
