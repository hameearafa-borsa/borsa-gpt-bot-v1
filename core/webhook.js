"use strict";

const http = require("node:http");

const DEFAULT_WEBHOOK_PATH = "/telegram/webhook";

function getWebhookConfig(env = process.env) {
  const rawUrl = String(env.WEBHOOK_URL || "").trim();
  const secret = String(env.WEBHOOK_SECRET || "").trim();
  if (!rawUrl) throw new Error("WEBHOOK_URL مطلوب ويجب أن يكون رابط HTTPS الكامل لنقطة استقبال Telegram.");
  if (!secret) throw new Error("WEBHOOK_SECRET مطلوب لحماية نقطة استقبال Telegram.");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error("WEBHOOK_SECRET يجب أن يتكون من 1 إلى 256 حرفًا من A-Z وa-z و0-9 و_ و- فقط.");
  }

  let parsed;
  try { parsed = new URL(rawUrl); }
  catch { throw new Error("WEBHOOK_URL ليس رابطًا صالحًا."); }
  if (parsed.protocol !== "https:") throw new Error("WEBHOOK_URL يجب أن يستخدم HTTPS.");
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("WEBHOOK_URL يجب أن يكون رابط HTTPS عامًا دون بيانات دخول أو query أو fragment.");
  }
  if (parsed.pathname === "/" || !parsed.pathname.startsWith("/")) {
    throw new Error(`WEBHOOK_URL يجب أن يتضمن مسارًا مخصصًا مثل ${DEFAULT_WEBHOOK_PATH}.`);
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT يجب أن يكون رقمًا صحيحًا بين 1 و65535.");
  return Object.freeze({ url: parsed.toString(), path: parsed.pathname, secret, port });
}

function createWebhookServer(bot, config) {
  if (!bot || typeof bot.webhookCallback !== "function") throw new TypeError("A Telegraf bot with webhookCallback() is required.");
  const callback = bot.webhookCallback(config.path, { secretToken: config.secret });
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; }
    catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ status: "ok", transport: "webhook" }));
      return;
    }
    if (req.method !== "POST" || pathname !== config.path) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    callback(req, res);
  });
}

module.exports = { getWebhookConfig, createWebhookServer };
