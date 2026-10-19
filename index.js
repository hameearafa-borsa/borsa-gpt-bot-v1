"use strict";
require("dotenv").config();

const { Telegraf } = require("telegraf");
const { createAI } = require("./core/ai");
const db = require("./core/database");
const { createGPTCore } = require("./core/gpt-core");
const { loadRegistry } = require("./core/product-registry");
const { claimMessage, isBotMessage, isLogChat } = require("./core/message-gate");
const { cacheMessage, getMessageByRef } = require("./core/message-cache");
const { log, makeReport, emitReport, redactString } = require("./core/diagnostics");
const { buildChemicalLinks, renderChemicalLinks } = require("./core/links");
const { send: logChannel, LOG_CHAT_ID } = require("./core/log-channel");
const { canManage, isMaster } = require("./core/permissions");
const { normalizeArabic } = require("./core/normalization");
const { isListLike, deterministicList, extractList } = require("./modules/price-list");
const priceMonitor = require("./modules/price-monitor");
const { saveMerchant } = require("./modules/merchant-intelligence");
const chemical = require("./modules/chemical-assistant");
const { admissionDecision, acquireInstanceLock, releaseInstanceLock, startTransport, ensureHttpServer } = require("./core/telegram-runtime");
const deals = require("./modules/deals");
const protection = require("./modules/protection");
const scheduler = require("./modules/scheduler");
const weather = require("./modules/weather");
const market = require("./modules/market");
const { startDealScheduler } = require("./modules/deal-scheduler");
const legacyAdmin = require("./modules/legacy-admin");
const adminPanel = require("./modules/admin-panel");
const { fetchSearch } = require("./modules/deal-sources");

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

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 90000 });
const ai = createAI();
const core = createGPTCore({ ai, registry, diagnostics: log });
let botUserId = null;
let stopScheduledMessages = () => {};
let stopDeals = () => {};
let shutdownPromise = null;
let transport = null;
let lockClient = null;
const recognizedAnnouncements = new Set();

function messageData(ctx) {
  const m = ctx.message || ctx.editedMessage || ctx.channelPost || ctx.callbackQuery?.message;
  return {
    chatId: m?.chat?.id,
    chatType: m?.chat?.type,
    messageId: m?.message_id,
    userId: ctx.callbackQuery?.from?.id || m?.from?.id,
    text: m?.text || "",
    caption: m?.caption || "",
    messageType: m?.photo ? "photo" : m?.document ? "document" : "text",
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

async function sendLog(event) { await logChannel(bot, event); }

async function authorizeChat(chatId, chatType, userId) {
  if (!db.pool) return false;
  await db.query(`INSERT INTO authorized_chats(chat_id,chat_type,owner_user_id,authorized_by)
    VALUES($1,$2,$3,$4) ON CONFLICT(chat_id) DO UPDATE SET
      chat_type=EXCLUDED.chat_type,
      owner_user_id=COALESCE(EXCLUDED.owner_user_id, authorized_chats.owner_user_id),
      authorized_by=COALESCE(EXCLUDED.authorized_by, authorized_chats.authorized_by),
      active=TRUE`,
    [chatId, chatType, userId || null, userId || null]);
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
  const commands = [
    { command: "panel", description: "لوحة التحكم الخاصة" },
    { command: "settings", description: "إعدادات المجموعة" },
    { command: "antispam", description: "إعدادات مانع الإزعاج" },
    { command: "schedule", description: "جدولة رسالة" },
    { command: "warn", description: "تسجيل إنذار" },
    { command: "warnings", description: "عرض الإنذارات" },
    { command: "clearwarn", description: "إغلاق الإنذارات" },
    { command: "activate", description: "تفعيل المجموعة الحالية" },
    { command: "inactive", description: "تقرير الأعضاء الخاملين" }
  ];
  // Hide the global/group menus, then show commands only in private chats of verified controllers.
  await bot.telegram.setMyCommands([], { scope: { type: "default" } });
  await bot.telegram.setMyCommands([
    { command: "activate", description: "تفعيل المجموعة الحالية" },
    { command: "id", description: "عرض معرف المحادثة" },
  ], { scope: { type: "all_group_chats" } });
  const ids = new Set([String(require("./core/permissions").MASTER_ID)]);
  try {
    const r = await db.query(`SELECT DISTINCT owner_user_id FROM authorized_chats WHERE active=TRUE AND chat_type IN ('group','supergroup') AND owner_user_id IS NOT NULL`);
    for (const row of r.rows) if (row.owner_user_id != null) ids.add(String(row.owner_user_id));
  } catch (error) {
    await sendLog({ module: "security", stage: "command_menu_owner_lookup", severity: "warn", status: "partial", details: { code: error.code || null } });
  }
  for (const id of ids) {
    const chatId = Number(id);
    if (!Number.isSafeInteger(chatId)) continue;
    try { await bot.telegram.setMyCommands(commands, { scope: { type: "chat", chat_id: chatId } }); }
    catch (error) { await sendLog({ module: "security", stage: "command_menu_private_scope", severity: "warn", status: "failed", details: { ownerId: chatId, code: error.code || null, message: error.message } }); }
  }
}

async function ensureDb() {
  const path = require("node:path");
  await db.runMigrations(path.join(__dirname, "migrations"), [
    "000_legacy_compat.sql",
    "001_core.sql",
    "002_operational.sql",
    "003_message_cache.sql",
    "004_legacy_services.sql",
    "005_deal_product_identity.sql",
    "006_price_observation_identity.sql",
  ]);
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
  if (["group", "supergroup"].includes(m.chatType) && m.text && !/^\s*\//.test(m.text) && !isBotMessage(ctx, botUserId)) {
    try {
      let opts = { anti_spam_enabled: true, block_excessive_links: true, max_links: 5, max_message_length: 5000, block_untrusted_forwards: false };
      const setting = await db.query("SELECT * FROM moderation_settings WHERE chat_id=$1", [m.chatId]).catch(() => ({ rows: [] }));
      if (setting.rows[0]) opts = { ...opts, ...setting.rows[0] };
      if (opts.anti_spam_enabled) {
        const result = protection.inspectMessage({ text: m.text, caption: m.caption, isForward: Boolean(ctx.message?.forward_origin || ctx.message?.forward_from || ctx.message?.forward_from_chat), trustedForward: false }, { maxLinks: opts.block_excessive_links ? opts.max_links : 999, maxLength: opts.max_message_length, blockUntrustedForwards: opts.block_untrusted_forwards });
        if (!result.allowed) {
          await db.query("INSERT INTO moderation_events(chat_id,message_id,user_id,action,reason,details) VALUES($1,$2,$3,$4,$5,$6)", [m.chatId, m.messageId || null, m.userId || null, process.env.PROTECTION_ENFORCE === "true" ? "delete_attempt" : "flagged", result.reasons.join(","), JSON.stringify({ length: result.length, linkCount: result.linkCount })]).catch(() => {});
          await sendLog({ module: "protection", stage: "message_flagged", severity: "warn", status: process.env.PROTECTION_ENFORCE === "true" ? "enforce_requested" : "audit_only", details: { chatId: m.chatId, messageId: m.messageId, userId: m.userId, reasons: result.reasons } });
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
  if (!chat || !["member", "administrator"].includes(nextStatus)) return;
  await admitJoinedChat(ctx.telegram, chat, u?.from?.id);
});

bot.on("new_chat_members", async ctx => {
  const members = ctx.message?.new_chat_members || [];
  if (!botUserId || !members.some((user) => user.id === botUserId)) return;
  await admitJoinedChat(ctx.telegram, ctx.chat, ctx.from?.id);
});

bot.action(/^panel:(home|chemical|prices|lists|merchants|deals|reports|protection|inactive|health|scraper_test|diagnostics|weather|market)$/, async ctx => {
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
    let aiState = "غير مختبر";
    try {
      const probe = await ai.generate("أجب بكلمة واحدة فقط: تمام", { maxOutputTokens: 40, reasoningEffort: "low" });
      aiState = probe?.text ? `استجابة من ${probe.provider}/${probe.model}` : "رد فارغ";
    } catch (e) { aiState = `فشل (${String(e.message || e).slice(0, 160)})`; }
    const body = `🩺 تشخيص النظام\nالإصدار: ${APP_VERSION}\nقاعدة البيانات: ${dbState}\nالذكاء الاصطناعي: ${aiState}\nالمفاتيح المضبوطة: ${(ai.providers || []).join("، ") || "لا يوجد"}\nSCRAPER_API_KEY: ${process.env.SCRAPER_API_KEY ? "موجود (القيمة مخفية)" : "غير مضبوط"}\nDEALS_CHAT_ID: ${process.env.DEALS_CHAT_ID ? "مضبوط" : "غير مضبوط"}\n\nفحص الذكاء يرسل طلبًا قصيرًا واحدًا. نجاح قاعدة البيانات لا يثبت نجاح كل متجر.`;
    await ctx.editMessageText(body, { reply_markup: adminPanel.actionKeyboard() }); return;
  }
  if (action === "scraper_test") {
    const result = await fetchSearch("amazon", "مسحوق غسيل", { timeoutMs: 10000 });
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
  if (action === "weather") {
    const result = await weather.getWeatherSummary(null, "القاهرة");
    await ctx.editMessageText(`${result.message}\n🔎 ${result.searchUrl}`, { reply_markup: adminPanel.actionKeyboard(), disable_web_page_preview: true });
    return;
  }
  if (action === "market") {
    const text = await market.reportText();
    await ctx.editMessageText(text, { reply_markup: adminPanel.actionKeyboard(), disable_web_page_preview: true });
    return;
  }
  const guides = {
    chemical: "🧪 المساعد الكيميائي\nاسأل عن مادة أو تركيبة مثل: وظيفة اللابسا، أو إطار سائل الجلي. الإجابة نص مرجعي محلي بنطاقات وتداول وتحذيرات. النموذج لا يضيف نسبة غير موجودة في المرجع. الخلط الخطر يُرفض بلا خطوات. يعمل في الخاص وفي المجموعة بعد التفعيل.",
    prices: "💰 رصد الأسعار\nالرصد التلقائي يعمل بصمت داخل المجموعة المصرح بها. أرسل سعرًا واضحًا في المجموعة، ولن تظهر رسالة لكل عملية رصد.",
    lists: "📋 قوائم الشركات\nاستخدم /قائمة ثم ألصق نص القائمة. لا ترسل رابطًا إلا إذا كانت الرسالة الأصلية قد مرّت على البوت وتم تخزين مرجعها. الصفوف غير الواضحة تُحال للمراجعة بدل التخمين.",
    merchants: "🏪 بيانات التجار\nتُحفظ البيانات فقط عند توافر مؤشرات موثوقة، ولا يطلب البوت من الأعضاء نشر بيانات شخصية بلا داعٍ.",
    deals: `🛍️ العروض\nحالة المفتاح: ${process.env.SCRAPER_API_KEY ? "موجود، استخدم زر اختبار المصدر" : "SCRAPER_API_KEY غير مضبوط"}\nحالة النشر: ${process.env.DEALS_CHAT_ID ? "وجهة النشر مضبوطة" : "DEALS_CHAT_ID غير مضبوط"}\nلا تُنشر عروض مخترعة عند فشل المصدر.`,
    protection: "🛡️ الحماية والإنذارات\nالأوامر الإدارية /antispam و/warn و/warnings و/clearwarn متاحة للمصرح لهم فقط. الحذف التلقائي يظل معطلاً ما لم يُفعّل صراحةً في البيئة. إجراء الإعدادات لكل مجموعة سيبقى مرتبطًا بمعرّف المجموعة وليس الخاص.",
    inactive: "👥 الأعضاء الخاملون\nاستخدم /inactive 30 داخل المجموعة المصرح بها. التقرير يعتمد على نشاط الرسائل التي رصدها البوت منذ بدء التتبع، وليس تعدادًا كاملًا للأعضاء."
  };
  await ctx.editMessageText(guides[action] || "الخدمة غير متاحة حاليًا.", { reply_markup: adminPanel.actionKeyboard() });
});

async function memberStatus(telegram, chatId, userId) {
  if (!telegram || !chatId || !userId) return null;
  try { return (await telegram.getChatMember(chatId, userId))?.status || null; }
  catch { return null; }
}

function holdText(chatId) {
  return [
    "هذه المجموعة غير مفعّلة بعد، ولم أغادرها.",
    `معرف المحادثة: ${chatId}`,
    "لتفعيل الرصد: اجعل البوت مشرفًا، أو أرسل /activate من منشئ المجموعة أو من مشرف.",
    "إذا لم تصل رسائل الأعضاء، عطّل Privacy Mode من BotFather.",
    "الأمر /id يعرض المعرف في أي وقت."
  ].join("\n");
}

async function announceHold(telegram, chatId, chatType, { force = false } = {}) {
  if (!chatId || chatType === "channel") return;
  if (await isAuthorizedChat(chatId)) return;
  const key = `hold:${chatId}`;
  if (!force && recognizedAnnouncements.has(key)) return;
  recognizedAnnouncements.add(key);
  await telegram.sendMessage(chatId, holdText(chatId)).catch(() => {});
}

async function announceReady(telegram, chatId, chatType) {
  if (!chatId || chatType === "channel") return;
  const key = `ok:${chatId}`;
  if (recognizedAnnouncements.has(key)) return;
  recognizedAnnouncements.add(key);
  await telegram.sendMessage(chatId, "تم التعرّف على المجموعة وتفعيلها.\nرصد الأسعار يبقى صامتًا. اسأل عن مادة أو تركيبة ليجيب المساعد الكيميائي من المرجع المحلي.\nإذا لم يرَ البوت رسائل الأعضاء، عطّل Privacy Mode من BotFather أو أبقِ البوت مشرفًا.").catch(() => {});
}

async function admitJoinedChat(telegram, chat, actorId) {
  if (!chat?.id) return;
  let actorStatus = null;
  let lookupFailed = false;
  if (chat.type !== "channel" && actorId) {
    try { actorStatus = (await telegram.getChatMember(chat.id, actorId))?.status || null; }
    catch { lookupFailed = true; }
  } else if (chat.type === "channel") {
    actorStatus = isMaster(actorId) ? "creator" : "member";
  }
  let botIsAdmin = false;
  if (botUserId) {
    try {
      const self = await memberStatus(telegram, chat.id, botUserId);
      botIsAdmin = self === "administrator" || self === "creator";
    } catch { botIsAdmin = false; }
  }
  const decision = admissionDecision({ isMasterActor: isMaster(actorId), actorStatus, lookupFailed, botIsAdmin });
  if (decision === "ignore") return;
  if (decision !== "authorize") {
    await sendLog({ module: "security", stage: "chat_join_unconfirmed", severity: "warn", status: "hold", details: { chatId: chat.id, actor: actorId, chatType: chat.type, actorStatus, lookupFailed } });
    await announceHold(telegram, chat.id, chat.type);
    return;
  }
  let ownerId = actorId || null;
  try {
    const admins = await telegram.getChatAdministrators(chat.id);
    ownerId = admins.find((admin) => admin.status === "creator")?.user?.id || ownerId;
  } catch { ownerId = actorId || null; }
  await authorizeChat(chat.id, chat.type, ownerId);
  await sendLog({ module: "security", stage: "chat_authorized", status: "ok", details: { chatId: chat.id, actor: actorId, ownerUserId: ownerId, chatType: chat.type, via: "join" } });
  await announceReady(telegram, chat.id, chat.type);
}

async function recognizeGroup(ctx, m, cmd) {
  const activating = cmd === "activate" || cmd === "تفعيل";
  const sender = isMaster(m.userId) ? "creator" : await memberStatus(ctx.telegram, m.chatId, m.userId);
  const self = await memberStatus(ctx.telegram, m.chatId, botUserId);
  const senderOk = isMaster(m.userId) || sender === "creator" || sender === "administrator";
  const botTrusted = self === "administrator" || self === "creator";
  if (!senderOk && !botTrusted) {
    await announceHold(ctx.telegram, m.chatId, m.chatType, { force: activating });
    if (!activating) console.warn(`[CHAT_HOLD] ${m.chatId} بانتظار /activate أو رفع البوت مشرفًا. لن يغادر.`);
    return false;
  }
  let ownerId = sender === "creator" ? m.userId : null;
  try {
    const admins = await ctx.telegram.getChatAdministrators(m.chatId);
    ownerId = admins.find((admin) => admin.status === "creator")?.user?.id || ownerId || (senderOk ? m.userId : null);
  } catch { ownerId = ownerId || (senderOk ? m.userId : null); }
  await authorizeChat(m.chatId, m.chatType, ownerId);
  await sendLog({ module: "security", stage: "chat_recognized", status: "ok", details: { chatId: m.chatId, userId: m.userId, via: activating ? "command" : "runtime", botStatus: self } });
  if (activating) recognizedAnnouncements.delete(`ok:${m.chatId}`);
  await announceReady(ctx.telegram, m.chatId, m.chatType);
  return true;
}

async function reconcileKnownChats() {
  const ids = new Set();
  if (process.env.DEALS_CHAT_ID) ids.add(String(process.env.DEALS_CHAT_ID).trim());
  for (const raw of String(process.env.GROUP_CHAT_IDS || "").split(",")) if (raw.trim()) ids.add(raw.trim());
  for (const raw of ids) {
    const chatId = Number(raw);
    if (!Number.isSafeInteger(chatId)) continue;
    try {
      const chat = await bot.telegram.getChat(chatId);
      const status = await memberStatus(bot.telegram, chatId, botUserId);
      if (!["creator", "administrator", "member"].includes(status)) {
        console.warn(`[CHAT_RECONCILE] ${chatId} حالة البوت=${status || "unknown"} — ليس عضوًا بعد.`);
        continue;
      }
      let ownerId = null;
      try {
        const admins = await bot.telegram.getChatAdministrators(chatId);
        ownerId = admins.find((admin) => admin.status === "creator")?.user?.id || null;
      } catch {}
      await authorizeChat(chat.id, chat.type, ownerId);
      console.log(`[CHAT_RECONCILE] فُعّلت ${chat.id} (${chat.type}) وحالة البوت=${status}`);
    } catch (err) {
      console.warn(`[CHAT_RECONCILE_FAIL] ${chatId} ${err.code || ""} ${redactString(err.message)}`);
    }
  }
}

bot.on("text", async ctx => {
  const m = messageData(ctx);
  if (!["group", "supergroup", "private"].includes(m.chatType)) return;
  if (isBotMessage(ctx, botUserId)) return;
  const text = m.text;
  const cmd = commandName(text);
  const args = commandText(text);
  if (cmd === "id" || cmd === "chatid" || cmd === "المعرف") {
    await ctx.reply(`معرف هذه المحادثة: ${m.chatId}\nنوعها: ${m.chatType}\nفي المجموعات: ارفع البوت مشرفًا ثم أرسل /activate، أو اطلب ذلك من المنشئ.`);
    return;
  }
  if (["group", "supergroup"].includes(m.chatType)) {
    const known = await isAuthorizedChat(m.chatId);
    if (!known) {
      const admitted = await recognizeGroup(ctx, m, cmd);
      if (!admitted) return;
    }
    if (cmd === "activate" || cmd === "تفعيل") {
      if (known) await ctx.reply("المجموعة مفعّلة بالفعل. الرصد يعمل، والمساعد الكيميائي يجيب أسئلة المواد والتركيبات.");
      return;
    }
  }

  // Ordinary members may use automatic services, but slash commands are controller-only.
  if (cmd && !(await canControl(ctx, m))) return;

  if ((cmd === "panel" || cmd === "start") && m.chatType === "private") {
    await showPrivatePanel(ctx, false);
    return;
  }

  if (cmd === "قائمة") {
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
      const run = await db.query(`INSERT INTO price_list_runs(source_chat_id,source_message_id,raw_text,status,extracted_count,accepted_count,skipped_count)
        VALUES($1,$2,$3,'processed',$4,$5,$6) RETURNING id`, [m.chatId, m.messageId, sourceText, rows.length, accepted.length, rows.length - accepted.length]);
      for (const row of rows) {
        await db.query(`INSERT INTO price_list_items(run_id,product_label,variant_label,company_label,weight_g,volume_ml,package_sale_price,wholesale_carton_price,consumer_price,pack_count,confidence,raw_line,decision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [run.rows[0].id, row.product || row.product_text || null, row.variant || null, row.company || parsedList.company || null, row.weight_g ?? null, row.volume_ml ?? null, row.package_sale_price ?? null, row.wholesale_carton_price ?? null, row.consumer_price ?? null, row.pack_count ?? null, row.confidence ?? null, row.raw_line || row.rawLine || null, row.decision || "review"]);
      }
    }
    await sendLog({ module: "price-list", stage: "processed", status: "ok", details: { actor: m.userId, extracted: rows.length, accepted: accepted.length, method: parsedList.method, company: parsedList.company || null } });
    await ctx.reply(`✅ تمت قراءة القائمة في صمت.\nالأصناف الواضحة: ${accepted.length}\nالمراجعة: ${rows.length - accepted.length}\n\n${BOT_CREDIT}`);
    return;
  }

  if (cmd === "مساعد" || cmd === "كيمياء" || cmd === "المساعد_الكيميائي") {
    const question = args || "اكتب سؤالك الكيميائي بوضوح.";
    const answer = await chemical.answer(ai, question);
    const links = buildChemicalLinks(question);
    await ctx.reply([answer, renderChemicalLinks(links)].filter(Boolean).join("\n\n"), { disable_web_page_preview: true });
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
    if (!match) { await ctx.reply("الصيغة: /schedule 2026-10-13T17:00 نص الرسالة\nالموعد يُحسب بتوقيت القاهرة (Africa/Cairo)."); return; }
    try {
      const job = await scheduler.createScheduledMessage(db.pool, { chat_id: m.chatId, run_at: scheduler.cairoLocalToUtc(match[1]), message_text: match[2], created_by: m.userId, timezone: "Africa/Cairo" });
      await ctx.reply(`✅ تمت إضافة الرسالة المجدولة رقم ${job.id}.`);
    } catch (error) { await ctx.reply(`تعذر إنشاء الجدولة: ${error.message}`); }
    return;
  }

  if (cmd === "weather" || cmd === "الطقس") {
    const city = args || "القاهرة";
    const result = await weather.getWeatherSummary(ai, city);
    await ctx.reply(`${result.message}\n🔎 بحث الطقس: ${result.searchUrl}`, { disable_web_page_preview: true });
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

  if (!cmd && (chemical.looksLikeChemicalQuestion(text) || (m.chatType === "private" && /(كلور|مطهر|تركيبه|ماده|خلط|ph|حمض|قلوي|لابسا|تكسابون|سلفونيك)/i.test(normalizeArabic(text))))) {
    const answer = await chemical.answer(ai, text);
    const links = buildChemicalLinks(text);
    await ctx.reply([answer, renderChemicalLinks(links)].filter(Boolean).join("\n\n"), { disable_web_page_preview: true });
    return;
  }

  if (!priceMonitor.isEligibleMessage({ chatType: m.chatType, text, isLogChannel: false, isCommand: false, ownMessage: isBotMessage(ctx, botUserId) })) return;

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

  const classification = await core.classify(text, { chatId: m.chatId, messageId: m.messageId });
  if (classification.type !== "price_observation" && classification.type !== "price_list") return;
  const result = await priceMonitor.observe({ pool: db.pool, message: m, merchantId, registry });
  if (result.saved > 0) {
    await sendLog({ module: "price-monitor", stage: "saved", status: "ok", details: { saved: result.saved, merchantId, messageId: m.messageId } });
  }
});

bot.catch(async (err, ctx) => {
  const m = messageData(ctx || {});
  const report = makeReport({ module: "bot", stage: ctx?.updateType || "unknown", severity: "ERROR", action: "telegram_update", error: err, input: m.text || m.caption, chatId: m.chatId, messageId: m.messageId, details: { appVersion: APP_VERSION } });
  await emitReport({ bot, db, report });
  if (ctx?.reply && m.chatId && !isLogChat(m.chatId)) {
    await ctx.reply("تعذر إكمال الطلب. أُرسل تقرير التشخيص إلى قناة السجلات دون إظهار الأسرار.").catch(() => {});
  }
});

process.on("unhandledRejection", async err => {
  const report = makeReport({ module: "process", stage: "unhandledRejection", severity: "CRITICAL", action: "promise_rejection", error: err, details: { appVersion: APP_VERSION } });
  await emitReport({ bot, db, report });
});
process.on("uncaughtException", async err => {
  const report = makeReport({ module: "process", stage: "uncaughtException", severity: "CRITICAL", action: "uncaught_exception", error: err, details: { appVersion: APP_VERSION } });
  await emitReport({ bot, db, report });
});

async function startSchedulers() {
  await scheduler.ensureSchedulerSchema(db.pool);
  stopScheduledMessages = scheduler.startScheduler({ pool: db.pool, telegram: bot.telegram, onError: async (error, job) => {
    const report = makeReport({ module: "scheduler", stage: "dispatch_due", severity: "ERROR", action: "scheduled_message", error, details: { jobId: job?.id, chatId: job?.chat_id }, chatId: job?.chat_id });
    await emitReport({ bot, db, report });
  } });
  if (process.env.DEALS_CHAT_ID) {
    stopDeals = startDealScheduler({ pool: db.pool, telegram: bot.telegram, chatId: Number(process.env.DEALS_CHAT_ID), onError: async (error, details) => {
      const report = makeReport({ module: "deals", stage: details?.stage || "daily_cycle", severity: "ERROR", action: "deal_newsletter", error, details });
      await emitReport({ bot, db, report });
    } });
  } else {
    console.warn("[DEALS_SCHEDULER_DISABLED] Set DEALS_CHAT_ID after selecting the publication group.");
  }
}

(async () => {
  await ensureHttpServer(bot);
  await db.waitUntilReady();
  await ensureDb();
  const me = await bot.telegram.getMe();
  botUserId = me.id;
  await configureCommandMenus().catch(error => sendLog({ module: "security", stage: "command_menu_setup", severity: "warn", status: "failed", details: { code: error.code || null, message: error.message } }));
  console.log(`Borsa GBT Bot V1 Mona Lisa ${APP_VERSION} — @${me.username} — ${BOT_CREDIT}`);
  console.log(`AI providers configured: ${ai.providers.join(", ") || "none"}`);
  await reconcileKnownChats();
  transport = await startTransport(bot);
  console.log(`[TELEGRAM_MODE] ${transport.mode}`);
  lockClient = await acquireInstanceLock(db.pool);
  if (!lockClient) {
    console.warn("[SINGLE_INSTANCE] القفل عند نسخة أخرى. الاستقبال عبر webhook يعمل الآن، والجدولة تنتظر حتى تُغلق النسخة الأخرى.");
    while (!lockClient && !shutdownPromise) {
      await new Promise((resolve) => setTimeout(resolve, 15000));
      if (shutdownPromise) return;
      lockClient = await acquireInstanceLock(db.pool, { attempts: 1, delayMs: 0 }).catch((err) => {
        console.warn("[SINGLE_INSTANCE_LOCK]", redactString(err.message));
        return null;
      });
    }
  }
  if (shutdownPromise) return;
  await startSchedulers();
  console.log("[SCHEDULERS] بدأت بعد قفل النسخة الواحدة. الاستقبال لم يُؤجَّل بسبب القفل.");
})().catch(err => { console.error("STARTUP_FAILED", redactString(err?.stack || err?.message || "startup_error")); process.exit(1); });

async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[SHUTDOWN] ${signal}: stopping schedulers and closing connections`);
    try { stopScheduledMessages(); } catch (error) { console.error("[SHUTDOWN_SCHEDULER_ERROR]", error?.message || error); }
    try { stopDeals(); } catch (error) { console.error("[SHUTDOWN_DEALS_ERROR]", error?.message || error); }
    try { if (transport) await transport.stop(); } catch (error) { console.error("[SHUTDOWN_BOT_ERROR]", error?.message || error); }
    try { await releaseInstanceLock(lockClient); lockClient = null; } catch (error) { console.error("[SHUTDOWN_LOCK_ERROR]", error?.message || error); }
    try { await db.close(); } catch (error) { console.error("[SHUTDOWN_DATABASE_ERROR]", error?.message || error); process.exitCode = 1; }
    console.log("[SHUTDOWN] أُوقف webhook وحُرر قفل النسخة الواحدة.");
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => { shutdown("SIGINT").finally(() => process.exit(process.exitCode || 0)); });
process.once("SIGTERM", () => { shutdown("SIGTERM").finally(() => process.exit(process.exitCode || 0)); });
