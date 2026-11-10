"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const aiSource = fs.readFileSync(path.join(__dirname, "../core/ai.js"), "utf8");
const index = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const { createAI, providersFromEnv, retryGeminiRequest, geminiProvider, providerStatus, isGeminiRetryableError } = require("../core/ai");

assert.ok(aiSource.includes("gemini-3.8-flash"));
assert.ok(aiSource.includes("process.env.GEMINI_TIMEOUT_MS || 12000"), "Gemini attempts stay within Telegraf handler budget");
assert.ok(aiSource.includes("Math.min(12000, Number(process.env.GEMINI_TIMEOUT_MS || 12000))"), "Gemini attempt timeout is capped at 12 seconds even if Railway is misconfigured");
assert.ok(aiSource.includes("retryGeminiRequest"), "Gemini retries one transient service failure");
assert.ok(aiSource.includes("maxAttempts = Math.max(1, Math.min(2"), "Gemini retry count is strictly bounded to two attempts");
assert.ok(aiSource.includes("timeout: timeoutMs"), "provider-specific timeouts must be honored");
const openAISection = aiSource.slice(aiSource.indexOf("function openAIProvider"), aiSource.indexOf("function groqProvider"));
assert.ok(openAISection.length > 0, "OpenAI provider implementation should exist");
assert.ok(!openAISection.includes("temperature:"), "Responses request must not send unsupported temperature field");
assert.ok(openAISection.includes('if (options.webSearch === true)'), "OpenAI web search must be opt-in so emergency answers are not blocked by search latency");
assert.ok(openAISection.includes('type: "web_search"'), "OpenAI should retain hosted web search when explicitly requested");
assert.ok(openAISection.includes('tool_choice = "required"'), "an explicitly requested web search must actually execute");
assert.ok(openAISection.includes("web_search_call.action.sources"), "explicit web search should return source references");
const geminiSection = aiSource.slice(aiSource.indexOf("function geminiProvider"), aiSource.indexOf("function providersFromEnv"));
assert.ok(geminiSection.length > 0, "Gemini provider implementation should exist");
assert.ok(geminiSection.includes('import("@google/genai")'), "Gemini requests must use the installed official SDK");
assert.ok(geminiSection.includes("new GoogleGenAI"));
assert.ok(geminiSection.includes("retryOptions: { attempts: 1 }"), "the SDK retry layer must not multiply the app retry budget");
assert.ok(!geminiSection.includes("temperature"), "Gemini 3.8 Flash request must omit temperature sampling parameter");
assert.ok(!geminiSection.includes("generationConfig"), "Gemini request should omit deprecated sampling configuration");
assert.ok(aiSource.includes('AI_FALLBACK_ENABLED === "true"'));
assert.ok(aiSource.includes("function isCredentialError"));
assert.ok(aiSource.includes("fallbackProviders.flatMap"));
assert.ok(aiSource.includes("(isProviderWideFailure(e) && !rotateOpenAIKeyAfterTimeout) || (!retryable && !credentialError)"), "provider-wide failures should skip sibling keys except for bounded OpenAI timeout key rotation");
assert.ok(aiSource.includes("https://api.groq.com/openai/v1/chat/completions"));
assert.ok(aiSource.includes("GROQ_MODEL"));
assert.ok(aiSource.includes("GROQ_API_KEY_2"));
assert.ok(index.includes('const ai = createAI({ provider: "groq", fallbackProviders: ["gemini"] })'), "general AI routes must use Groq with Gemini-only fallback");
assert.ok(index.includes('const chemicalAI = createAI({ provider: "openai" })'), "chemical assistant must own the OpenAI route");
assert.ok(index.includes('const chemicalFallbackAI = createAI({ provider: "groq" })'), "chemical fallback must use Groq, never another OpenAI route");
assert.ok(!index.includes('createAI()'), "no unpinned AI instance may accidentally inherit OpenAI");
assert.ok(!index.includes('createAI({ provider: "gemini" })'), "Gemini must not be the chemical primary");

function provider(name, providerName, run) {
  return { name, provider: providerName, run };
}
function httpError(status, message = "simulated provider failure") {
  return new Error(`AI HTTP ${status}: ${message}`);
}

const envNames = ["AI_PROVIDER", "AI_FALLBACK_ENABLED", "GEMINI_API_KEY", "GEMINI_API_KEY_1", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3", "GEMINI_MODEL", "GEMINI_FALLBACK_MODEL", "GEMINI_REQUEST_BUDGET_MS"];
const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
try {
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "legacy-slot-one";
  delete process.env.GEMINI_API_KEY_1;
  delete process.env.GEMINI_API_KEY_2;
  delete process.env.GEMINI_API_KEY_3;
  const geminiConfigured = providersFromEnv().filter(p => p.provider === "gemini");
  assert.equal(geminiConfigured.length, 1);
  assert.equal(geminiConfigured[0].name, "GEMINI_API_KEY_1");
} finally {
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
}

(async () => {
  let transientCalls = 0;
  const recoveredAfter503 = await retryGeminiRequest(async () => {
    transientCalls += 1;
    if (transientCalls === 1) throw httpError(503, "upstream overloaded");
    return "Gemini recovered";
  }, { delayMs: 0 });
  assert.equal(recoveredAfter503, "Gemini recovered");
  assert.equal(transientCalls, 2, "a transient Gemini 503 gets exactly one retry");

  assert.equal(isGeminiRetryableError(httpError(503)), true, "Gemini 503 responses are eligible for a bounded retry");
  assert.equal(isGeminiRetryableError(httpError(504)), false, "Gemini 504 responses go directly to fallback to protect the total request budget");
  assert.equal(isGeminiRetryableError(httpError(429)), false, "quota/rate-limit responses are not blindly retried");

  const retryDelayEvents = [];
  let jitterCalls = 0;
  let retryPolicyCalls = 0;
  const retryPolicyResult = await retryGeminiRequest(async () => {
    retryPolicyCalls += 1;
    if (retryPolicyCalls === 1) throw httpError(503, "overloaded");
    return "bounded retry recovered";
  }, {
    delayMs: 10,
    maxDelayMs: 100,
    random: () => { jitterCalls += 1; return 0.5; },
    onRetry: event => retryDelayEvents.push(event)
  });
  assert.equal(retryPolicyResult, "bounded retry recovered");
  assert.equal(retryPolicyCalls, 2, "a retry policy makes at most two attempts");
  assert.equal(jitterCalls, 1, "retry delay includes bounded jitter");
  assert.equal(retryDelayEvents[0].status, 503);
  assert.ok(retryDelayEvents[0].delayMs >= 10 && retryDelayEvents[0].delayMs <= 13, "backoff delay is bounded and jittered");

  let deadlineRetryCalls = 0;
  await assert.rejects(retryGeminiRequest(async () => {
    deadlineRetryCalls += 1;
    throw httpError(503, "overloaded");
  }, {
    delayMs: 100,
    deadlineAt: Date.now() + 100,
    attemptTimeoutMs: 12000
  }));
  assert.equal(deadlineRetryCalls, 1, "a retry is skipped when the shared request budget cannot fit another full attempt");

  const sdkStatusError = new Error("temporary SDK failure");
  sdkStatusError.status = 503;
  assert.equal(providerStatus(sdkStatusError), 503, "SDK status fields must drive retry and provider fallback decisions");
  let sdkRetryCalls = 0;
  const recoveredSdkRequest = await retryGeminiRequest(async () => {
    sdkRetryCalls++;
    if (sdkRetryCalls === 1) throw sdkStatusError;
    return "SDK retry recovered";
  }, { delayMs: 0 });
  assert.equal(recoveredSdkRequest, "SDK retry recovered");
  assert.equal(sdkRetryCalls, 2, "an SDK 503 receives exactly one application-managed retry");

  let sdkLoads = 0;
  let sdkConstructors = 0;
  let sdkOptions;
  const sdkRequests = [];
  class FakeGoogleGenAI {
    constructor(options) {
      sdkConstructors++;
      sdkOptions = options;
      this.models = {
        async generateContent(request) {
          sdkRequests.push(request);
          return { text: "إجابة Gemini عبر المكتبة الرسمية" };
        }
      };
    }
  }
  const sdkGemini = geminiProvider("sdk-test-key", "gemini-3.8-flash", {
    timeoutMs: 9000,
    loadSdk: async () => {
      sdkLoads++;
      return { GoogleGenAI: FakeGoogleGenAI };
    }
  });
  const sdkAnswer = await sdkGemini("اختبر اتصال المساعد الكيميائي");
  const sdkAnswerAgain = await sdkGemini("سؤال آخر");
  await sdkGemini("سؤال مدعوم بالبحث", { googleSearch: true });
  assert.equal(sdkAnswer.text, "إجابة Gemini عبر المكتبة الرسمية");
  assert.equal(sdkAnswer.provider, "gemini");
  assert.equal(sdkAnswerAgain.model, "gemini-3.8-flash");
  assert.equal(sdkLoads, 1, "the SDK module should be loaded once per provider");
  assert.equal(sdkConstructors, 1, "one authenticated SDK client should be reused per key");
  assert.deepEqual(sdkOptions, {
    apiKey: "sdk-test-key",
    httpOptions: { timeout: 9000, retryOptions: { attempts: 1 } }
  });
  assert.deepEqual(sdkRequests[0], {
    model: "gemini-3.8-flash",
    contents: "اختبر اتصال المساعد الكيميائي",
    config: { automaticContinuation: false }
  });
  assert.deepEqual(sdkRequests[2].config.tools, [{ googleSearch: {} }], "chemical Gemini requests can enable Google Search grounding");

  const retryingPrimaryRequests = [];
  class RetryingPrimaryGoogleGenAI {
    constructor() {
      this.models = {
        async generateContent(request) {
          retryingPrimaryRequests.push(request);
          if (retryingPrimaryRequests.length === 1) {
            const error = new Error("temporary overload");
            error.status = 503;
            throw error;
          }
          return { text: "تم التعافي بعد إعادة المحاولة" };
        }
      };
    }
  }
  const retryingPrimaryGemini = geminiProvider("retry-primary-test-key", "gemini-3.8-flash", {
    fallbackModel: "gemini-3.6-flash",
    loadSdk: async () => ({ GoogleGenAI: RetryingPrimaryGoogleGenAI })
  });
  const retryPrimaryLogs = [];
  const retryPrimaryOriginalInfo = console.info;
  const retryPrimaryOriginalWarn = console.warn;
  console.info = message => retryPrimaryLogs.push(String(message));
  console.warn = message => retryPrimaryLogs.push(String(message));
  let retryPrimaryAnswer;
  try {
    retryPrimaryAnswer = await retryingPrimaryGemini("اختبار إعادة محاولة الأساسي");
  } finally {
    console.info = retryPrimaryOriginalInfo;
    console.warn = retryPrimaryOriginalWarn;
  }
  assert.equal(retryPrimaryAnswer.text, "تم التعافي بعد إعادة المحاولة");
  assert.deepEqual(retryingPrimaryRequests.map(request => request.model), [
    "gemini-3.8-flash",
    "gemini-3.8-flash"
  ], "a primary 503 is retried once before considering the alternate model");
  assert.ok(retryPrimaryLogs.some(line => line.includes("[GEMINI_RETRY] stage=primary") && line.includes("status=503")), "primary retry scheduling must be logged");

  const retryingFallbackRequests = [];
  class RetryingFallbackGoogleGenAI {
    constructor() {
      this.models = {
        async generateContent(request) {
          retryingFallbackRequests.push(request);
          if (request.model === "gemini-3.8-flash") {
            const error = new Error("primary deadline exceeded");
            error.status = 504;
            throw error;
          }
          if (retryingFallbackRequests.filter(item => item.model === "gemini-3.6-flash").length === 1) {
            const error = new Error("fallback overloaded");
            error.status = 503;
            throw error;
          }
          return { text: "تم التعافي عبر الاحتياطي" };
        }
      };
    }
  }
  const retryingFallbackGemini = geminiProvider("retry-fallback-test-key", "gemini-3.8-flash", {
    fallbackModel: "gemini-3.6-flash",
    loadSdk: async () => ({ GoogleGenAI: RetryingFallbackGoogleGenAI })
  });
  const retryFallbackLogs = [];
  const retryFallbackOriginalInfo = console.info;
  const retryFallbackOriginalWarn = console.warn;
  console.info = message => retryFallbackLogs.push(String(message));
  console.warn = message => retryFallbackLogs.push(String(message));
  let retryFallbackAnswer;
  try {
    retryFallbackAnswer = await retryingFallbackGemini("اختبار إعادة محاولة الاحتياطي");
  } finally {
    console.info = retryFallbackOriginalInfo;
    console.warn = retryFallbackOriginalWarn;
  }
  assert.equal(retryFallbackAnswer.text, "تم التعافي عبر الاحتياطي");
  assert.deepEqual(retryingFallbackRequests.map(request => request.model), [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.6-flash"
  ], "the alternate model also receives one bounded retry for a transient 503");
  assert.ok(retryFallbackLogs.some(line => line.includes("[GEMINI_RETRY] stage=fallback") && line.includes("status=503")), "fallback retry scheduling must be logged");

  const savedRequestBudget = process.env.GEMINI_REQUEST_BUDGET_MS;
  process.env.GEMINI_REQUEST_BUDGET_MS = "5";
  const exhaustedBudgetRequests = [];
  class ExhaustedBudgetGoogleGenAI {
    constructor() {
      this.models = {
        async generateContent(request) {
          exhaustedBudgetRequests.push(request);
          await new Promise(resolve => setTimeout(resolve, 10));
          const error = new Error("primary deadline exceeded");
          error.status = 504;
          throw error;
        }
      };
    }
  }
  const exhaustedBudgetGemini = geminiProvider("budget-test-key", "gemini-3.8-flash", {
    timeoutMs: 1,
    fallbackModel: "gemini-3.6-flash",
    loadSdk: async () => ({ GoogleGenAI: ExhaustedBudgetGoogleGenAI })
  });
  const exhaustedBudgetLogs = [];
  const budgetOriginalInfo = console.info;
  const budgetOriginalWarn = console.warn;
  console.info = message => exhaustedBudgetLogs.push(String(message));
  console.warn = message => exhaustedBudgetLogs.push(String(message));
  try {
    await assert.rejects(exhaustedBudgetGemini("اختبار انتهاء الميزانية"));
  } finally {
    console.info = budgetOriginalInfo;
    console.warn = budgetOriginalWarn;
    if (savedRequestBudget === undefined) delete process.env.GEMINI_REQUEST_BUDGET_MS;
    else process.env.GEMINI_REQUEST_BUDGET_MS = savedRequestBudget;
  }
  assert.deepEqual(exhaustedBudgetRequests.map(request => request.model), ["gemini-3.8-flash"], "the fallback must not start after the shared request budget is exhausted");
  assert.ok(exhaustedBudgetLogs.some(line => line.includes("reason=request_budget_exhausted")), "budget exhaustion must be recorded as a fallback skip reason");

  const fallbackRequests = [];
  class FallbackGoogleGenAI {
    constructor() {
      this.models = {
        async generateContent(request) {
          fallbackRequests.push(request);
          if (request.model === "gemini-3.8-flash") {
            const error = new Error("upstream deadline expired");
            error.status = 504;
            throw error;
          }
          return { text: "إجابة المحرك الاحتياطي" };
        }
      };
    }
  }
  const fallbackGemini = geminiProvider("fallback-test-key", "gemini-3.8-flash", {
    fallbackModel: "gemini-3.6-flash",
    loadSdk: async () => ({ GoogleGenAI: FallbackGoogleGenAI })
  });
  const geminiLogs = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = message => geminiLogs.push(String(message));
  console.warn = message => geminiLogs.push(String(message));
  let fallbackAnswer;
  try {
    fallbackAnswer = await fallbackGemini("اختبر المحرك الاحتياطي");
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
  assert.equal(fallbackAnswer.text, "إجابة المحرك الاحتياطي");
  assert.equal(fallbackAnswer.provider, "gemini");
  assert.equal(fallbackAnswer.model, "gemini-3.6-flash");
  assert.deepEqual(fallbackRequests.map(request => request.model), [
    "gemini-3.8-flash",
    "gemini-3.6-flash"
  ], "a transient primary-model failure should trigger exactly one alternate Gemini model request");
  assert.ok(geminiLogs.some(line => line.includes("stage=primary model=gemini-3.8-flash outcome=failed status=504")), "logs must identify the failed primary model and HTTP status");
  assert.ok(geminiLogs.some(line => line.includes("stage=fallback model=gemini-3.6-flash outcome=succeeded")), "logs must identify successful fallback model");
  assert.ok(geminiLogs.some(line => line.includes("outcome=succeeded primary_model=gemini-3.8-flash fallback_model=gemini-3.6-flash")), "logs must record fallback completion");
  assert.ok(!geminiLogs.some(line => line.includes("اختبر المحرك الاحتياطي") || line.includes("fallback-test-key")), "model logs must not expose prompts or API keys");

  const permanentModelRequests = [];
  class PermanentGoogleGenAI {
    constructor() {
      this.models = {
        async generateContent(request) {
          permanentModelRequests.push(request);
          const error = new Error("unsupported request");
          error.status = 400;
          throw error;
        }
      };
    }
  }
  const permanentModelGemini = geminiProvider("permanent-test-key", "gemini-3.8-flash", {
    fallbackModel: "gemini-3.6-flash",
    loadSdk: async () => ({ GoogleGenAI: PermanentGoogleGenAI })
  });
  await assert.rejects(permanentModelGemini("سؤال غير صالح"));
  assert.deepEqual(permanentModelRequests.map(request => request.model), [
    "gemini-3.8-flash"
  ], "permanent request errors must not trigger alternate-model fallback");

  let permanentRetryCalls = 0;
  await assert.rejects(retryGeminiRequest(async () => {
    permanentRetryCalls += 1;
    throw httpError(400, "invalid request");
  }, { delayMs: 0 }));
  assert.equal(permanentRetryCalls, 1, "permanent Gemini request errors are not retried");

  const googleOnlyCalls = [];
  const googleOnly = createAI({ provider: "gemini", providers: [
    provider("GEMINI_API_KEY_1", "gemini", async () => { googleOnlyCalls.push("gemini"); throw httpError(503, "Google unavailable"); }),
    provider("OPENAI_API_KEY", "openai", async () => { googleOnlyCalls.push("openai"); return { text: "must not run", provider: "openai" }; }),
    provider("GROQ_API_KEY", "groq", async () => { googleOnlyCalls.push("groq"); return { text: "must not run", provider: "groq" }; })
  ] });
  await assert.rejects(googleOnly.generate("chemical test"));
  assert.deepEqual(googleOnlyCalls, ["gemini"], "chemical AI must never fall back to OpenAI or Groq");

  const calls = [];
  const providers = [
    provider("GEMINI_API_KEY_1", "gemini", async () => { calls.push("gemini-1"); throw httpError(503); }),
    provider("GEMINI_API_KEY_2", "gemini", async () => { calls.push("gemini-2"); throw httpError(503); }),
    provider("OPENAI_API_KEY", "openai", async () => { calls.push("openai"); throw httpError(503); }),
    provider("GROQ_API_KEY", "groq", async () => { calls.push("groq"); return { text: "ok", provider: "groq" }; })
  ];
  const routed = createAI({ provider: "gemini", fallbackProviders: ["openai", "groq"], providers });
  const result = await routed.generate("test prompt");
  assert.equal(result.provider, "groq");
  assert.deepEqual(calls, ["gemini-1", "groq"], "non-chemical routes must skip OpenAI and provider-wide failures should skip sibling keys");

  const slowGeminiCalls = [];
  const slowGeminiProviders = [
    provider("GEMINI_API_KEY_1", "gemini", async () => { slowGeminiCalls.push("gemini-1"); throw httpError(503, "upstream overloaded"); }),
    provider("GEMINI_API_KEY_2", "gemini", async () => { slowGeminiCalls.push("gemini-2"); return { text: "must not call sibling key", provider: "gemini" }; }),
    provider("OPENAI_API_KEY", "openai", async () => { slowGeminiCalls.push("openai"); return { text: "recovered answer", provider: "openai" }; })
  ];
  const slowGeminiRouted = createAI({ provider: "gemini", fallbackProviders: ["openai"], providers: slowGeminiProviders });
  await assert.rejects(slowGeminiRouted.generate("test prompt"));
  assert.deepEqual(slowGeminiCalls, ["gemini-1"], "a non-chemical route must not use OpenAI as a fallback");

  const rateLimitCalls = [];
  const rateLimitProviders = [
    provider("GEMINI_API_KEY_1", "gemini", async () => { rateLimitCalls.push("gemini-1"); throw httpError(429, "quota exceeded"); }),
    provider("GEMINI_API_KEY_2", "gemini", async () => { rateLimitCalls.push("gemini-2"); return { text: "Gemini answer", provider: "gemini" }; }),
    provider("OPENAI_API_KEY", "openai", async () => { rateLimitCalls.push("openai"); return { text: "must not call fallback", provider: "openai" }; })
  ];
  const rateLimitRouted = createAI({ provider: "gemini", fallbackProviders: ["openai"], providers: rateLimitProviders });
  const rateLimitResult = await rateLimitRouted.generate("test prompt");
  assert.equal(rateLimitResult.provider, "gemini");
  assert.deepEqual(rateLimitCalls, ["gemini-1", "gemini-2"], "a key-specific 429 should rotate to another Gemini key before changing providers");
  const openAITimeoutCalls = [];
  const openAITimeoutProviders = [
    provider("OPENAI_API_KEY", "openai", async (_prompt, options) => { openAITimeoutCalls.push(["openai-1", options.timeoutMs]); throw new Error("AI timeout"); }),
    provider("OPENAI_API_KEY_2", "openai", async (_prompt, options) => { openAITimeoutCalls.push(["openai-2", options.timeoutMs]); throw new Error("AI timeout"); }),
    provider("OPENAI_API_KEY_3", "openai", async (_prompt, options) => { openAITimeoutCalls.push(["openai-3", options.timeoutMs]); return { text: "OpenAI recovered", provider: "openai" }; }),
    provider("GROQ_API_KEY", "groq", async () => { openAITimeoutCalls.push(["groq"]); return { text: "must not run", provider: "groq" }; })
  ];
  const rotatingOpenAI = createAI({ provider: "openai", fallbackProviders: ["groq"], providers: openAITimeoutProviders });
  const rotatedOpenAI = await rotatingOpenAI.generate("chemical prompt", { timeoutMs: 3500, requestBudgetMs: 14000 });
  assert.equal(rotatedOpenAI.provider, "openai");
  assert.deepEqual(openAITimeoutCalls.map(call => call[0]), ["openai-1", "openai-2", "openai-3"], "an OpenAI timeout should rotate through configured keys before changing provider");
  assert.ok(openAITimeoutCalls.every(call => call[1] <= 3500), "each OpenAI key attempt must stay within its per-key timeout");

  const groqRescueCalls = [];
  const groqRescueProviders = [
    provider("OPENAI_API_KEY", "openai", async () => { groqRescueCalls.push("openai-1"); throw new Error("AI timeout"); }),
    provider("OPENAI_API_KEY_2", "openai", async () => { groqRescueCalls.push("openai-2"); throw new Error("AI timeout"); }),
    provider("OPENAI_API_KEY_3", "openai", async () => { groqRescueCalls.push("openai-3"); throw new Error("AI timeout"); }),
    provider("GROQ_API_KEY", "groq", async () => { groqRescueCalls.push("groq-1"); throw httpError(429, "rate limit"); }),
    provider("GROQ_API_KEY_2", "groq", async () => { groqRescueCalls.push("groq-2"); return { text: "Groq rescue answer", provider: "groq" }; })
  ];
  const groqRescue = createAI({ provider: "openai", fallbackProviders: ["groq"], providers: groqRescueProviders });
  const groqRecovered = await groqRescue.generate("chemical prompt", { timeoutMs: 3500, requestBudgetMs: 14000 });
  assert.equal(groqRecovered.provider, "groq");
  assert.deepEqual(groqRescueCalls, ["openai-1", "openai-2", "openai-3", "groq-1", "groq-2"], "all configured OpenAI keys should be tried before Groq, which can rotate to its second key on a key-specific 429");

  assert.ok(index.includes("chemical.answer(chemicalAI, chemicalInput") && index.includes("}), chemicalFallbackAI);"), "automatic group chemical questions must receive the same OpenAI/Groq rescue path as /chemical");

  const credentialCalls = [];
  const credentialProviders = [
    provider("GEMINI_API_KEY_1", "gemini", async () => { credentialCalls.push("gemini-1"); throw httpError(401, "invalid_api_key"); }),
    provider("GEMINI_API_KEY_2", "gemini", async () => { credentialCalls.push("gemini-2"); return { text: "ok", provider: "gemini" }; }),
    provider("OPENAI_API_KEY", "openai", async () => { credentialCalls.push("openai"); return { text: "unexpected", provider: "openai" }; })
  ];
  const credentialRouted = createAI({ provider: "gemini", fallbackProviders: ["openai"], providers: credentialProviders });
  const credentialResult = await credentialRouted.generate("test prompt");
  assert.equal(credentialResult.provider, "gemini");
  assert.deepEqual(credentialCalls, ["gemini-1", "gemini-2"]);

  const permanentCalls = [];
  const permanentProviders = [
    provider("GEMINI_API_KEY_1", "gemini", async () => { permanentCalls.push("gemini-1"); throw httpError(400, "unsupported model"); }),
    provider("GEMINI_API_KEY_2", "gemini", async () => { permanentCalls.push("gemini-2"); return { text: "should not run", provider: "gemini" }; }),
    provider("OPENAI_API_KEY", "openai", async () => { permanentCalls.push("openai"); return { text: "fallback", provider: "openai" }; })
  ];
  const permanentRouted = createAI({ provider: "gemini", fallbackProviders: ["openai"], providers: permanentProviders });
  await assert.rejects(permanentRouted.generate("test prompt"));
  assert.deepEqual(permanentCalls, ["gemini-1"], "OpenAI must not be selected as a non-chemical fallback");

  const emptyResponseCalls = [];
  const emptyResponseProviders = [
    provider("GEMINI_API_KEY_1", "gemini", async () => { emptyResponseCalls.push("gemini"); return { text: "   ", provider: "gemini" }; }),
    provider("OPENAI_API_KEY", "openai", async () => { emptyResponseCalls.push("openai"); return { text: "OpenAI answer", provider: "openai" }; }),
    provider("GROQ_API_KEY", "groq", async () => { emptyResponseCalls.push("groq"); return { text: "Groq answer", provider: "groq" }; })
  ];
  const emptyResponseRouted = createAI({ provider: "gemini", fallbackProviders: ["openai", "groq"], providers: emptyResponseProviders });
  const emptyResponseResult = await emptyResponseRouted.generate("test prompt");
  assert.equal(emptyResponseResult.provider, "groq");
  assert.equal(emptyResponseResult.text, "Groq answer");
  assert.deepEqual(emptyResponseCalls, ["gemini", "groq"]);

  const allFailProviders = [
    provider("GEMINI_API_KEY_1", "gemini", async () => { throw httpError(503, "Gemini unavailable"); }),
    provider("OPENAI_API_KEY", "openai", async () => { throw httpError(503, "OpenAI unavailable"); }),
    provider("GROQ_API_KEY", "groq", async () => { throw httpError(503, "Groq unavailable"); })
  ];
  const allFailRouted = createAI({ provider: "gemini", fallbackProviders: ["openai", "groq"], providers: allFailProviders });
  await assert.rejects(allFailRouted.generate("test prompt"), error => {
    assert.equal(error.aiProvider, "groq");
    return true;
  });

  // General routes remain isolated from OpenAI even when legacy env flags request it.
  process.env.AI_PROVIDER = "openai";
  process.env.AI_FALLBACK_ENABLED = "true";
  const generalCalls = [];
  const general = createAI({ providers: [
    provider("OPENAI_API_KEY", "openai", async () => {
      generalCalls.push("openai"); return { text: "must never run", provider: "openai" };
    }),
    provider("GROQ_API_KEY", "groq", async () => {
      generalCalls.push("groq"); throw httpError(503);
    }),
    provider("GEMINI_API_KEY_1", "gemini", async () => {
      generalCalls.push("gemini"); return { text: "safe fallback", provider: "gemini" };
    })
  ] });
  const generalResult = await general.generate("general classification");
  assert.equal(generalResult.provider, "gemini");
  assert.deepEqual(generalCalls, ["groq", "gemini"], "general requests may use Groq then Gemini but must never consume OpenAI keys");

  // OpenAI is reachable only when a caller explicitly selects it (chemical route).
  const explicitChemicalCalls = [];
  const explicitChemical = createAI({ provider: "openai", fallbackProviders: ["groq"], providers: [
    provider("OPENAI_API_KEY", "openai", async () => {
      explicitChemicalCalls.push("openai"); return { text: "chemical answer", provider: "openai" };
    }),
    provider("GROQ_API_KEY", "groq", async () => {
      explicitChemicalCalls.push("groq"); return { text: "fallback answer", provider: "groq" };
    }),
    provider("GEMINI_API_KEY_1", "gemini", async () => {
      explicitChemicalCalls.push("gemini"); return { text: "must not run", provider: "gemini" };
    })
  ] });
  const chemicalResult = await explicitChemical.generate("chemical formulation");
  assert.equal(chemicalResult.provider, "openai");
  assert.deepEqual(explicitChemicalCalls, ["openai"], "the chemical route owns OpenAI and may fall back only to its explicit Groq route");

  console.log("AI provider routing and chemical fallback unit tests: OK");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
