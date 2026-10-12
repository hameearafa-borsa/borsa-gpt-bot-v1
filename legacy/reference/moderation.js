"use strict";

/**
 * طبقة الحماية للمجموعة الخارقة (supergroup).
 * تُهيأ عبر setupModeration ثم تُركّب كـ middleware في Telegraf.
 */

const { Markup } = require("telegraf");

const FLOOD_WINDOW_MS = 12_000;
const MEDIA_WINDOW_MS = 60_000;
const REPEAT_WINDOW_MS = 90_000;
const ADMIN_CACHE_TTL_MS = 5 * 60_000;

const BAD_PATTERNS = [
  /كس أم/i,
  /كسمك/i,
  /عرص/i,
  /شرموط/i,
  /قحبة/i,
  /خول(?!ة)/i,
  /ابن ال[كل]/i,
  /fuck\s*you/i,
  /porn/i,
  /onlyfans/i,
  /xxx/i,
  /استثمار\s*مضمون/i,
  /ربح\s*يومي/i,
  /forex/i,
  /signal(s)?\s*vip/i,
];

const SPAM_INVITE = /t\.me\/(\+|joinchat\/)/i;

const SHOPPING_HOSTS = [
  "noon.com",
  "noon.partners",
  "amazon.eg",
  "amazon.com",
  "amazon.sa",
  "amzn.eg",
  "amzn.to",
  "a.co",
  "jumia.com",
  "jumia.com.eg",
  "jumia.eg",
  "carrefouregypt.com",
  "carrefour.com.eg",
  "kazyon.com",
  "kazyon.app",
  "instashop.com",
  "breadfast.com",
  "rabbitmart.com",
  "maxab.io",
  "maxab.com",
  "olx.com.eg",
  "dubizzle.com.eg",
  "instagram.com",
  "instagr.am",
];

const UNWRAP_HOSTS = new Set([
  "bit.ly",
  "cutt.ly",
  "tinyurl.com",
  "t.co",
  "rb.gy",
  "is.gd",
  "shorturl.at",
  "ow.ly",
  "rebrand.ly",
  "s.id",
  "b.link",
  "tiny.cc",
  "amzn.to",
  "a.co",
  "l.facebook.com",
  "lm.facebook.com",
  "l.instagram.com",
  "google.com",
  "google.com.eg",
  "www.google.com",
]);

const resolveCache = new Map();

function parseUrlLoose(raw) {
  const s = String(raw || "").trim();
  if (!s || s.startsWith("@") || s.startsWith("t.me/+")) return null;
  try {
    return new URL(s.includes("://") ? s : `https://${s}`);
  } catch {
    return null;
  }
}

function hostOf(url) {
  return (url.hostname || "").replace(/^www\./i, "").toLowerCase();
}

function isPrivateHost(host) {
  if (!host || host === "localhost" || host.endsWith(".local")) return true;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const p = host.split(".").map(Number);
  const a = p[0];
  const b = p[1];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31);
}

function hostMatches(host, allowedHost) {
  const a = String(allowedHost || "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase();
  if (!a || !host) return false;
  return host === a || host.endsWith(`.${a}`);
}

function wrappedTarget(url) {
  const q = url.searchParams.get("q") || url.searchParams.get("u") || url.searchParams.get("url") || url.searchParams.get("redirect");
  if (q && /^https?:\/\//i.test(q)) return parseUrlLoose(q);
  return null;
}

function isShoppingHost(host) {
  return SHOPPING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

async function resolveFinalHost(raw) {
  const first = parseUrlLoose(raw);
  if (!first) return "";
  const inner = wrappedTarget(first);
  if (inner) return hostOf(inner);
  const host = hostOf(first);
  if (!UNWRAP_HOSTS.has(host) && !UNWRAP_HOSTS.has(first.hostname.toLowerCase())) return host;
  if (isPrivateHost(host)) return host;
  const key = first.href.split("?")[0];
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.t < 30 * 60_000) return hit.host;
  try {
    const res = await fetch(first.href, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(2500),
    });
    const finalHost = hostOf(new URL(res.url));
    if (!isPrivateHost(finalHost)) {
      resolveCache.set(key, { host: finalHost, t: Date.now() });
      return finalHost;
    }
  } catch {
    /* اختصار فشل — نكتفي بالمضيف الظاهر */
  }
  return host;
}

let d = null;
const adminCache = new Map();

function setupModeration(deps) {
  d = deps;
}

function s() {
  return d.getSettings();
}

function uid(ctx) {
  return ctx.from?.id;
}

function isPrivate(ctx) {
  return ctx.chat?.type === "private";
}

function isGroup(ctx) {
  const t = ctx.chat?.type;
  return t === "group" || t === "supergroup";
}

function skipUser(ctx) {
  const id = uid(ctx);
  if (!id) return true;
  if (ctx.from.is_bot) return true;
  if (d.isAuthorizedAdmin(id)) return true;
  if (ctx.senderChat && ctx.senderChat.id === ctx.chat?.id) return true;
  return false;
}

async function isChatAdmin(ctx, userId) {
  if (!ctx.chat?.id || !userId) return false;
  const key = `${ctx.chat.id}:${userId}`;
  const hit = adminCache.get(key);
  if (hit && Date.now() - hit.ts < ADMIN_CACHE_TTL_MS) return hit.isAdmin;
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    const isAdmin = member.status === "creator" || member.status === "administrator";
    adminCache.set(key, { isAdmin, ts: Date.now() });
    return isAdmin;
  } catch {
    return false;
  }
}

function trackActivity(ctx) {
  const id = uid(ctx);
  if (!id || !isGroup(ctx)) return;
  d.userActivity.set(String(id), {
    t: Date.now(),
    name: ctx.from?.first_name || "",
    username: ctx.from?.username || "",
    chatId: ctx.chat.id,
  });
  if (typeof d.scheduleSaveActivity === "function") d.scheduleSaveActivity();
}

function messageText(ctx) {
  const m = ctx.message || ctx.editedMessage;
  if (!m) return "";
  return m.text || m.caption || "";
}

function collectUrls(msg) {
  const urls = [];
  const bags = [msg.entities, msg.caption_entities].filter(Boolean);
  const body = msg.text || msg.caption || "";
  for (const ents of bags) {
    for (const e of ents) {
      if (e.type === "url") urls.push(body.slice(e.offset, e.offset + e.length));
      else if (e.type === "text_link" && e.url) urls.push(e.url);
      else if (e.type === "mention") urls.push(body.slice(e.offset, e.offset + e.length));
    }
  }
  const extra = body.match(/https?:\/\/[^\s<>]+/gi) || [];
  urls.push(...extra);
  if (SPAM_INVITE.test(body)) urls.push("t.me/+");
  return [...new Set(urls.map((u) => String(u).replace(/[),.;]+$/g, "")))];
}

function allowByList(raw, host) {
  const allowed = d.loadAllowed() || [];
  const hay = String(raw || "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .toLowerCase();
  for (const item of allowed) {
    const a = String(item || "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "");
    if (!a) continue;
    if (a.includes("/")) {
      if (hay.includes(a)) return true;
      continue;
    }
    if (host && hostMatches(host, a)) return true;
    if (!host && hay.includes(a)) return true;
  }
  for (const rawId of d.ALLOWED_CHAT_IDS || []) {
    const id = String(rawId).replace(/^-100/, "");
    if (hay.includes(`t.me/c/${id}`)) return true;
  }
  return false;
}

async function isAllowedUrl(url) {
  const raw = String(url || "");
  const lower = raw.toLowerCase();
  if (SPAM_INVITE.test(lower) || lower.includes("t.me/+") || lower.includes("joinchat/")) {
    return allowByList(raw, "");
  }
  const parsed = parseUrlLoose(raw);
  const host = parsed ? hostOf(parsed) : "";
  if (allowByList(raw, host)) return true;
  if (host && isShoppingHost(host)) return true;
  const inner = parsed ? wrappedTarget(parsed) : null;
  if (inner) {
    const innerHost = hostOf(inner);
    if (isShoppingHost(innerHost) || allowByList(inner.href, innerHost)) return true;
  }
  if (host && (UNWRAP_HOSTS.has(host) || UNWRAP_HOSTS.has((parsed?.hostname || "").toLowerCase()))) {
    const finalHost = await resolveFinalHost(raw);
    if (finalHost && (isShoppingHost(finalHost) || allowByList(finalHost, finalHost))) return true;
  }
  return false;
}

function forwardOriginId(msg) {
  if (!msg) return null;
  if (msg.is_automatic_forward) return "linked-channel";
  const o = msg.forward_origin;
  if (o) {
    if (o.type === "channel" || o.type === "chat") return o.chat?.id ?? null;
    if (o.type === "user") return o.sender_user?.id ?? null;
    if (o.type === "hidden_user") return "hidden";
  }
  if (msg.forward_from_chat?.id) return msg.forward_from_chat.id;
  if (msg.forward_from?.id) return msg.forward_from.id;
  if (msg.forward_date) return "unknown";
  return null;
}

function isAllowedForwardOrigin(originId) {
  if (originId === "linked-channel") return true;
  if (originId == null) return true;
  const allowed = (d.ALLOWED_CHAT_IDS || []).map(String);
  const asStr = String(originId);
  if (allowed.includes(asStr)) return true;
  if (allowed.includes(asStr.replace(/^-100/, ""))) return true;
  if (allowed.includes(`-100${asStr}`)) return true;
  return false;
}

async function deleteQuiet(ctx) {
  try {
    await ctx.deleteMessage();
  } catch {
    /* البوت قد لا يملك صلاحية الحذف */
  }
}

async function warnUser(ctx, reason) {
  const id = uid(ctx);
  const key = String(id);
  const max = s().warnMax || 3;
  const current = (d.userWarnings.get(key) || 0) + 1;
  d.userWarnings.set(key, current);
  d.saveWarnings();

  const name = d.escHtml(ctx.from?.first_name || "عضو");
  try {
    await ctx.reply(
      `⚠️ <b>إنذار ${current}/${max}</b> — ${name}\n${d.escHtml(reason)}`,
      { parse_mode: "HTML" }
    );
  } catch {
    /* تجاهل */
  }

  await d.logAction(`إنذار ${current}/${max} للمستخدم ${id} — ${reason}`);

  if (current >= max) {
    d.userWarnings.set(key, 0);
    d.saveWarnings();
    const action = s().warnAction || "mute";
    if (action !== "none") {
      await d.applyPenalty(ctx, id, action, `تجاوز حد الإنذارات (${reason})`);
    }
  }
}

function bumpCounter(map, userId, windowMs) {
  const now = Date.now();
  const rec = map.get(userId) || { n: 0, t: now };
  if (now - rec.t > windowMs) {
    rec.n = 1;
    rec.t = now;
  } else {
    rec.n += 1;
  }
  map.set(userId, rec);
  return rec.n;
}

async function handleNewMembers(ctx) {
  const members = ctx.message?.new_chat_members;
  if (!members?.length) return;
  trackActivity(ctx);
  if (s().deleteServiceMessages) await deleteQuiet(ctx);
  if (!s().welcome) return;
  const names = members
    .filter((m) => !m.is_bot)
    .map((m) => d.escHtml(m.first_name || "عضو"));
  if (!names.length) return;
  const mention = names.join("، ");
  const body = d.escHtml(s().welcomeText || d.DEFAULT_WELCOME_TEXT);
  try {
    await ctx.reply(`مرحباً ${mention}\n\n${body}`, { parse_mode: "HTML" });
  } catch (e) {
    d.sendErrorAlert(e, "رسالة الترحيب");
  }
}

async function handleLeftMember(ctx) {
  const left = ctx.message?.left_chat_member;
  if (!left || left.is_bot) return;
  if (s().deleteServiceMessages) await deleteQuiet(ctx);
  if (!s().farewell) return;
  const contact = s().adminContact || d.DEFAULT_ADMIN_CONTACT;
  const text = (s().farewellText || d.DEFAULT_FAREWELL_TEXT).replace(
    /@AbdalhamidHammad/g,
    contact
  );
  try {
    await ctx.telegram.sendMessage(left.id, text);
  } catch {
    /* المستخدم لم يبدأ محادثة مع البوت */
  }
  await d.logAction(`👋 غادر: ${left.first_name} (${left.id})`);
}

async function moderationMiddleware(ctx, next) {
  if (!d) return next();

  if (ctx.chatJoinRequest && s().autoApproveJoin) {
    try {
      await ctx.approveChatJoinRequest();
      await d.logAction(`✅ قبول انضمام: ${ctx.from?.id}`);
    } catch (e) {
      d.sendErrorAlert(e, "قبول طلب انضمام");
    }
    return;
  }

  const msg = ctx.message || ctx.editedMessage;
  if (!msg) return next();

  if (msg.new_chat_members) {
    await handleNewMembers(ctx);
    return;
  }
  if (msg.left_chat_member) {
    await handleLeftMember(ctx);
    return;
  }

  if (!isGroup(ctx)) return next();
  if (ctx.session?.step) return next();
  if (typeof msg.text === "string" && msg.text.startsWith("/")) return next();
  if (skipUser(ctx)) {
    trackActivity(ctx);
    return next();
  }
  if (await isChatAdmin(ctx, uid(ctx))) {
    trackActivity(ctx);
    return next();
  }

  trackActivity(ctx);
  const id = uid(ctx);
  const st = s();

  if (st.antiForward) {
    const origin = forwardOriginId(msg);
    if (origin && origin !== "linked-channel" && !isAllowedForwardOrigin(origin)) {
      await deleteQuiet(ctx);
      await warnUser(ctx, "منع التوجيه من مصادر غير مصرّح بها");
      return;
    }
  }

  if (st.antiLink) {
    const urls = collectUrls(msg);
    const verdicts = await Promise.all(urls.map((u) => isAllowedUrl(u)));
    if (urls.length && verdicts.some((ok) => !ok)) {
      await deleteQuiet(ctx);
      await warnUser(ctx, "رابط غير مسموح");
      return;
    }
  }

  if (st.antiBadWords) {
    const text = messageText(ctx);
    if (text && BAD_PATTERNS.some((re) => re.test(text))) {
      await deleteQuiet(ctx);
      await warnUser(ctx, "ألفاظ غير لائقة");
      return;
    }
  }

  if (st.antiRepeat && msg.text) {
    const rec = d.userRepeatTracker.get(id) || { text: "", n: 0, t: 0 };
    const now = Date.now();
    if (rec.text === msg.text && now - rec.t < REPEAT_WINDOW_MS) {
      rec.n += 1;
      rec.t = now;
    } else {
      rec.text = msg.text;
      rec.n = 1;
      rec.t = now;
    }
    d.userRepeatTracker.set(id, rec);
    if (rec.n >= (st.maxFloodMsgs || 5)) {
      await deleteQuiet(ctx);
      await d.applyPenalty(ctx, id, st.penaltyType, "تكرار نفس الرسالة");
      d.userRepeatTracker.delete(id);
      return;
    }
  }

  if (st.antiSpam) {
    const n = bumpCounter(d.userMsgTracker, id, FLOOD_WINDOW_MS);
    if (n > (st.maxFloodMsgs || 5)) {
      await deleteQuiet(ctx);
      await d.applyPenalty(ctx, id, st.penaltyType, "إغراق (Flood)");
      d.userMsgTracker.delete(id);
      return;
    }

    if (msg.photo) {
      const photos = bumpCounter(
        d.userMediaTracker,
        `p:${id}`,
        MEDIA_WINDOW_MS
      );
      if (photos > (st.maxPhotos || 3)) {
        await deleteQuiet(ctx);
        await d.applyPenalty(ctx, id, st.penaltyType, "تجاوز حد الصور");
        return;
      }
    }
    if (msg.video || msg.video_note) {
      const videos = bumpCounter(
        d.userMediaTracker,
        `v:${id}`,
        MEDIA_WINDOW_MS
      );
      if (videos > (st.maxVideos || 2)) {
        await deleteQuiet(ctx);
        await d.applyPenalty(ctx, id, st.penaltyType, "تجاوز حد الفيديو");
        return;
      }
    }
  }

  if (st.antiPorn && msg.photo && typeof d.isNsfwImage === "function") {
    try {
      const shot = msg.photo[msg.photo.length - 1];
      const link = await ctx.telegram.getFileLink(shot.file_id);
      const nsfw = await d.isNsfwImage(link.href);
      if (nsfw) {
        await deleteQuiet(ctx);
        await d.applyPenalty(ctx, id, "ban", "محتوى إباحي");
        return;
      }
    } catch (e) {
      console.error("NSFW check failed:", e.message);
    }
  }

  return next();
}

function undoKeyboard(type, userId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("إلغاء العقوبة", `undo_penalty_${type}_${userId}`)],
  ]);
}

module.exports = {
  setupModeration,
  moderationMiddleware,
  isChatAdmin,
  undoKeyboard,
  adminCache,
};
