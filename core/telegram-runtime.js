"use strict";

const http = require("node:http");
const { redactString } = require("./diagnostics");

const ALLOWED_UPDATES = Object.freeze([
  "message",
  "edited_message",
  "channel_post",
  "callback_query",
  "my_chat_member",
  "chat_member",
]);
const LOCK_KEY = 84219011;
const WEBHOOK_PATH = "/telegram/webhook";

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const done = () => { clearTimeout(timer); resolve(); };
    if (signal.aborted) return done();
    signal.addEventListener("abort", done, { once: true });
  });
}

function isConflictError(err) {
  const code = Number(err?.response?.error_code || err?.code);
  const message = String(err?.description || err?.message || "");
  return code === 409 || /terminated by other getUpdates|webhook is active|conflict/i.test(message);
}

function conflictDelayMs(attempt) {
  return Math.min(30_000, 1500 * Math.max(1, Number(attempt) || 1));
}

function admissionDecision({ isMasterActor = false, actorStatus = null, lookupFailed = false, botIsAdmin = false } = {}) {
  if (isMasterActor || botIsAdmin) return "authorize";
  if (actorStatus === "creator" || actorStatus === "administrator") return "authorize";
  if (actorStatus === "left" || actorStatus === "kicked") return "ignore";
  // عضو عادي أو تعذر معرفة رتبته: نبقى في المجموعة ونطلب /activate. المغادرة كانت تُظهر أن البوت «لم يتعرف».
  return "hold";
}

function sanitizeSecret(raw) {
  const clean = String(raw || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 256);
  return clean.length >= 8 ? clean : "";
}

function normalizeWebhookUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url;
  try { url = new URL(value); } catch { return ""; }
  if (url.protocol !== "https:") return "";
  url.hash = "";
  url.search = "";
  url.username = "";
  url.password = "";
  const path = url.pathname.replace(/\/+$/, "");
  const basePath = path === "/telegram/webhook" || path === "/webhook" ? "" : path;
  url.pathname = `${basePath}${WEBHOOK_PATH}`.replace(/\/{2,}/g, "/");
  return url.toString();
}

function resolveWebhookTarget(env = process.env) {
  const named = [
    ["WEBHOOK_URL", env.WEBHOOK_URL],
    ["WEBHOOK_DOMAIN", env.WEBHOOK_DOMAIN],
    ["RAILWAY_PUBLIC_DOMAIN", env.RAILWAY_PUBLIC_DOMAIN],
    ["RAILWAY_STATIC_URL", env.RAILWAY_STATIC_URL],
  ];
  for (const [source, raw] of named) {
    const hook = normalizeWebhookUrl(raw);
    if (hook) return { hook, source };
  }
  return null;
}

function webhookBase() {
  const target = resolveWebhookTarget();
  if (!target) return "";
  try { return new URL(target.hook).origin; } catch { return ""; }
}

async function tryLock(pool) {
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [LOCK_KEY]);
    if (result.rows[0]?.locked) return client;
  } catch (err) {
    client.release();
    throw err;
  }
  client.release();
  return null;
}

async function acquireInstanceLock(pool, { attempts = 8, delayMs = 3000 } = {}) {
  if (!pool) throw new Error("DATABASE_URL غير مضبوط");
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const client = await tryLock(pool);
      if (client) return client;
      console.warn(`[SINGLE_INSTANCE] ${attempt}/${attempts}: نسخة أخرى ما زالت على نفس قاعدة البيانات. الاستقبال لا يُؤجَّل بسبب هذا القفل.`);
    } catch (err) {
      lastError = err;
      console.warn(`[SINGLE_INSTANCE_LOCK] ${attempt}/${attempts}: ${err.code || ""} ${redactString(err.message)}`);
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  if (lastError && attempts === 1) throw lastError;
  return null;
}

async function releaseInstanceLock(client) {
  if (!client) return;
  try { await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]); } catch {}
  try { client.release(); } catch {}
}

function startHttpServer({ bot, port, secret }) {
  const server = http.createServer(async (req, res) => {
    const pathname = String(req.url || "/").split("?")[0];
    if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("borsa-gpt-bot ok");
      return;
    }
    if (!(req.method === "POST" && pathname === WEBHOOK_PATH)) {
      res.writeHead(404); res.end("not found"); return;
    }
    if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
      res.writeHead(401); res.end("unauthorized"); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let update;
    try { update = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch { res.writeHead(400); res.end("bad json"); return; }
    res.writeHead(200); res.end("ok");
    try { await bot.handleUpdate(update); }
    catch (err) { console.error("[WEBHOOK_UPDATE]", redactString(err?.message || "update_failed")); }
  });
  return new Promise((resolve) => {
    server.once("error", (err) => {
      console.error("[HEALTH_BIND]", err.code || "", redactString(err.message));
      resolve(null);
    });
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

let httpServer = null;
let httpSecret = "";

async function ensureHttpServer(bot) {
  const port = Number(process.env.PORT || 8080);
  httpSecret = sanitizeSecret(process.env.WEBHOOK_SECRET);
  if (process.env.WEBHOOK_SECRET && !httpSecret) {
    console.warn("[WEBHOOK_SECRET] القيمة تحتوي رموزًا غير مقبولة أو أقصر من 8 خانات بعد التنظيف. سيُسجَّل الـ webhook من دون سر حتى لا يرفض تيليجرام الطلب. استخدم أحرفًا إنجليزية وأرقامًا و _ و - فقط.");
  }
  if (httpServer) return httpServer;
  httpServer = await startHttpServer({ bot, port, secret: httpSecret });
  if (httpServer) console.log(`[HEALTH] الفحص الصحي وwebhook على المنفذ ${port}${httpSecret ? " مع سر الاستقبال" : ""}`);
  return httpServer;
}

async function registerWebhook(bot, target) {
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await bot.telegram.setWebhook(target.hook, {
        allowed_updates: ALLOWED_UPDATES,
        drop_pending_updates: false,
        secret_token: httpSecret || undefined,
      });
      const info = await bot.telegram.getWebhookInfo();
      const host = new URL(target.hook).host;
      console.log(`[WEBHOOK] مُسجَّل على ${host} من المصدر ${target.source}. لا يوجد polling ولا getUpdates، لذلك هذه النسخة لا تسبب خطأ 409.`);
      if (info?.url && info.url !== target.hook) console.warn(`[WEBHOOK_MISMATCH] تيليجرام أبقى عنوانًا مختلفًا على ${new URL(info.url).host}`);
      if (info?.last_error_message) console.warn(`[WEBHOOK_LAST_ERROR] ${redactString(info.last_error_message)}`);
      if (Number(info?.pending_update_count) > 0) console.log(`[WEBHOOK_PENDING] تحديثات معلّقة: ${info.pending_update_count}`);
      return info;
    } catch (err) {
      last = err;
      console.warn(`[WEBHOOK_SET] ${attempt}/5 ${err?.code || ""} ${redactString(err?.message || "setWebhook_failed")}`);
      await sleep(1500 * attempt);
    }
  }
  throw last || new Error("تعذر تسجيل webhook");
}

async function startTransport(bot) {
  const server = await ensureHttpServer(bot);
  const target = resolveWebhookTarget();
  if (!target) {
    console.error("[WEBHOOK_MISSING] لا يوجد دومين عام. اضبط WEBHOOK_URL أو أنشئ Public Networking في Railway ليظهر RAILWAY_PUBLIC_DOMAIN. لن يُستخدم polling حتى لا يتكرر خطأ 409 مع النسخة القديمة.");
    return { mode: "webhook-waiting", stop: async () => { server?.close(); } };
  }
  if (!server) throw new Error("خادم الاستقبال لم يبدأ. تأكد أن المنفذ PORT متاح.");
  await registerWebhook(bot, target);
  const timer = setInterval(() => { registerWebhook(bot, target).catch(() => {}); }, 30 * 60 * 1000);
  timer.unref?.();
  return {
    mode: "webhook",
    stop: async () => {
      clearInterval(timer);
      server?.close();
    },
  };
}

module.exports = {
  ALLOWED_UPDATES,
  LOCK_KEY,
  WEBHOOK_PATH,
  isConflictError,
  conflictDelayMs,
  admissionDecision,
  sanitizeSecret,
  normalizeWebhookUrl,
  resolveWebhookTarget,
  acquireInstanceLock,
  releaseInstanceLock,
  startTransport,
  ensureHttpServer,
  webhookBase,
};
