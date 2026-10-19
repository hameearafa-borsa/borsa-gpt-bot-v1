"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  admissionDecision, isConflictError, conflictDelayMs, ALLOWED_UPDATES,
  sanitizeSecret, normalizeWebhookUrl, resolveWebhookTarget,
} = require("../core/telegram-runtime");
const chemical = require("../modules/chemical-assistant");

assert.equal(admissionDecision({ isMasterActor: true, actorStatus: "member" }), "authorize");
assert.equal(admissionDecision({ actorStatus: "creator" }), "authorize");
assert.equal(admissionDecision({ actorStatus: "administrator" }), "authorize");
assert.equal(admissionDecision({ actorStatus: "member", botIsAdmin: true }), "authorize");
assert.equal(admissionDecision({ lookupFailed: true }), "hold");
assert.equal(admissionDecision({ actorStatus: null }), "hold");
assert.equal(admissionDecision({ actorStatus: "member" }), "hold");
assert.equal(admissionDecision({ actorStatus: "restricted" }), "hold");
assert.equal(admissionDecision({ actorStatus: "left" }), "ignore");
assert.equal(admissionDecision({ actorStatus: "kicked" }), "ignore");

assert.equal(isConflictError({ response: { error_code: 409 }, message: "Conflict" }), true);
assert.equal(isConflictError({ message: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" }), true);
assert.equal(isConflictError({ description: "Webhook is active" }), true);
assert.equal(isConflictError({ message: "Bad Request: chat not found", response: { error_code: 400 } }), false);

assert.equal(conflictDelayMs(1), 1500);
assert.equal(conflictDelayMs(3), 4500);
assert.equal(conflictDelayMs(100), 30000);
assert.ok(ALLOWED_UPDATES.includes("my_chat_member"));
assert.ok(ALLOWED_UPDATES.includes("message"));
assert.ok(ALLOWED_UPDATES.includes("chat_member"));

assert.equal(sanitizeSecret("short"), "");
assert.equal(sanitizeSecret("سر عربي"), "");
assert.equal(sanitizeSecret("bad secret!!"), "badsecret");
assert.equal(sanitizeSecret("webhook_secret_1"), "webhook_secret_1");

assert.equal(normalizeWebhookUrl("myapp.up.railway.app"), "https://myapp.up.railway.app/telegram/webhook");
assert.equal(normalizeWebhookUrl("https://myapp.up.railway.app/telegram/webhook"), "https://myapp.up.railway.app/telegram/webhook");
assert.equal(normalizeWebhookUrl("https://myapp.up.railway.app/webhook"), "https://myapp.up.railway.app/telegram/webhook");
assert.equal(normalizeWebhookUrl("https://myapp.up.railway.app/telegram/webhook/"), "https://myapp.up.railway.app/telegram/webhook");
assert.equal(normalizeWebhookUrl("http://myapp.up.railway.app"), "");
assert.equal(normalizeWebhookUrl("https://user:pass@myapp.up.railway.app/path?x=1#h"), "https://myapp.up.railway.app/path/telegram/webhook");

const preferred = resolveWebhookTarget({ WEBHOOK_URL: "https://custom.example/telegram/webhook", RAILWAY_PUBLIC_DOMAIN: "other.up.railway.app" });
assert.equal(preferred.source, "WEBHOOK_URL");
assert.equal(preferred.hook, "https://custom.example/telegram/webhook");
const railway = resolveWebhookTarget({ WEBHOOK_URL: "http://insecure.example", RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" });
assert.equal(railway.source, "RAILWAY_PUBLIC_DOMAIN");
assert.equal(railway.hook, "https://app.up.railway.app/telegram/webhook");
assert.equal(resolveWebhookTarget({}), null);

const indexSource = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const runtimeSource = fs.readFileSync(path.join(__dirname, "../core/telegram-runtime.js"), "utf8");
assert.doesNotMatch(indexSource, /leaveChat\s*\(|\.getUpdates\s*\(|deleteWebhook\s*\(|\.launch\s*\(/);
assert.doesNotMatch(runtimeSource, /\.getUpdates\s*\(|deleteWebhook\s*\(|runPolling\s*\(/);
const startup = indexSource.slice(indexSource.indexOf("await ensureHttpServer(bot);"));
assert.ok(startup.indexOf("startTransport") < startup.indexOf("acquireInstanceLock"));
assert.ok(startup.indexOf("acquireInstanceLock") < startup.indexOf("startSchedulers"));

assert.equal(chemical.looksLikeChemicalQuestion("كلور 5 ك 40 ج"), false);
assert.equal(chemical.looksLikeChemicalQuestion("أريال 2 كيلو 490 جنيه"), false);
assert.equal(chemical.looksLikeChemicalQuestion("ما وظيفة اللابسا"), true);
assert.equal(chemical.looksLikeChemicalQuestion("ممكن تركيبة سائل جلي"), true);
assert.ok(chemical.findMaterials("ما وظيفة اللابسا").some((item) => item.key === "labsa"));

(async () => {
  const local = await chemical.answer(null, "ما وظيفة اللابسا");
  assert.match(local, /سلفونيك|LABSA/);
  assert.match(local, /8–15%|النطاق المرجعي/);
  assert.match(local, /المرجع المحلي/);
  assert.doesNotMatch(local, /أحتاج اسم المادة/);

  const framework = await chemical.answer(null, "تركيبة سائل جلي");
  assert.match(framework, /سائل جلي/);
  assert.match(framework, /لا يُضاف كلور/);
  assert.ok(framework.length > 180);

  const gated = await chemical.answer({ generate: async () => ({ text: "اخلطهما بنسبة 1 إلى 1 ثم سخّن." }) }, "اخلط الكلور مع الحمض");
  assert.match(gated, /تحذير سلامة/);
  assert.doesNotMatch(gated, /1 إلى 1|سخّن/);

  const thin = await chemical.answer({ generate: async () => ({ text: "اللابسا مادة تنظيف." }) }, "ما وظيفة اللابسا");
  assert.match(thin, /المرجع المحلي/);
  assert.match(thin, /النطاق المرجعي/);
  assert.doesNotMatch(thin, /إضافة ضمن المرجع/);

  const invented = "أضف ٩٩٪ من مادة غير مذكورة ثم ارفع الحرارة إلى 180 درجة وهذا سطر طويل يكفي لتجاوز حد الإضافة حتى لا يُقبل رقم مخترع.";
  const rejected = await chemical.answer({ generate: async () => ({ text: invented }) }, "ما وظيفة اللابسا");
  assert.doesNotMatch(rejected, /٩٩|99|180/);
  assert.match(rejected, /النطاق المرجعي/);

  const faithful = "الوظيفة إزالة الدهون بعد التعادل، والنطاق المرجعي 8–15 قبل ضبط pH بين 6.5 و 8. لا تُضاف أي نسبة خارج هذا المرجع المحلي في تجربة الإنتاج.";
  const accepted = await chemical.answer({ generate: async () => ({ text: faithful }) }, "ما وظيفة اللابسا");
  assert.match(accepted, /إضافة ضمن المرجع المحلي فقط/);
  assert.match(accepted, /8–15/);
  console.log("admission and chemical tests: OK");
})().catch((error) => { console.error(error); process.exit(1); });
