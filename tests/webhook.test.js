"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const { getWebhookConfig, createWebhookServer } = require("../core/webhook");

const base = { WEBHOOK_URL: "https://example.test/telegram/webhook", WEBHOOK_SECRET: "safe_test-secret_123", PORT: "3000" };
const config = getWebhookConfig(base);
assert.equal(config.url, base.WEBHOOK_URL);
assert.equal(config.path, "/telegram/webhook");
assert.equal(config.port, 3000);
assert.throws(() => getWebhookConfig({ ...base, WEBHOOK_URL: "http://example.test/hook" }), /HTTPS/);
assert.throws(() => getWebhookConfig({ ...base, WEBHOOK_URL: "https://example.test/" }), /مسارًا مخصصًا/);
assert.throws(() => getWebhookConfig({ ...base, WEBHOOK_SECRET: "bad secret" }), /WEBHOOK_SECRET/);
assert.throws(() => getWebhookConfig({ ...base, PORT: "99999" }), /PORT/);
assert.throws(() => getWebhookConfig({ ...base, WEBHOOK_URL: "" }), /WEBHOOK_URL/);

(async () => {
  let callbackCalls = 0;
  const bot = { webhookCallback(path, options) {
    assert.equal(path, config.path);
    assert.equal(options.secretToken, config.secret);
    return (_req, res) => { callbackCalls++; res.writeHead(200); res.end("update accepted"); };
  } };
  const server = createWebhookServer(bot, config);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  try {
    const health = await request(port, "GET", "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: "ok", transport: "webhook" });
    const missing = await request(port, "POST", "/wrong");
    assert.equal(missing.status, 404);
    assert.equal(callbackCalls, 0);
    const update = await request(port, "POST", config.path, "{}");
    assert.equal(update.status, 200);
    assert.equal(callbackCalls, 1);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  console.log("Webhook configuration and local HTTP routing tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });

function request(port, method, path, body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} }, res => {
      let data = ""; res.setEncoding("utf8"); res.on("data", chunk => data += chunk); res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject); if (body) req.write(body); req.end();
  });
}
