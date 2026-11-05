"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const aiSource = fs.readFileSync(path.join(__dirname, "../core/ai.js"), "utf8");
const index = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const { createAI, providersFromEnv, retryGeminiRequest, geminiProvider, providerStatus, isGeminiRetryableError } = require("../core/ai");

assert.ok(aiSource.includes("gemini-3.8-flash"));
assert.ok(aiSource.includes("process.env.GEMINI_TIMEOUT_MS || 12000"), "Gemini attempts stay within Telegraf handler budget");
assert.ok(aiSource.includes("retryGeminiRequest"), "Gemini retries one transient service failure");
assert.ok(aiSource.includes("maxAttempts = Math.max(1, Math.min(2"), "Gemini retry count is strictly bounded to two attempts");
assert.ok(aiSource.includes("timeout: timeoutMs"), "provider-specific timeouts must be honored");
const openAISection = aiSource.slice(aiSource.indexOf("function openAIProvider"), aiSource.indexOf("function groqProvider"));
assert.ok(openAISection.length > 0, "OpenAI provider implementation should exist");
assert.ok(!openAISection.includes("temperature:"), "Responses request must not send unsupported temperature field");
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
assert.ok(aiSource.includes("isProviderWideFailure(e) || (!retryable && !credentialError)"), "provider-wide failures should skip sibling keys when cross-provider fallback is enabled");
assert.ok(aiSource.includes("https://api.groq.com/openai/v1/chat/completions"));
assert.ok(aiSource.includes("GROQ_MODEL"));
assert.ok(aiSource.includes("GROQ_API_KEY_2"));
assert.ok(index.includes('createAI({ provider: "gemini" })'), "chemical assistant must be pinned to Google only");
assert.ok(index.includes("never silently answer via OpenAI or Groq"));

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
  assert.deepEqual(calls, ["gemini-1", "openai", "groq"], "provider-wide failures should skip remaining keys for the same provider");

  const slowGeminiCalls = [];
  const slowGeminiProviders = [
    provider("GEMINI_API_KEY_1", "gemini", async () => { slowGeminiCalls.push("gemini-1"); throw httpError(503, "upstream overloaded"); }),
    provider("GEMINI_API_KEY_2", "gemini", async () => { slowGeminiCalls.push("gemini-2"); return { text: "must not call sibling key", provider: "gemini" }; }),
    provider("OPENAI_API_KEY", "openai", async () => { slowGeminiCalls.push("openai"); return { text: "recovered answer", provider: "openai" }; })
  ];
  const slowGeminiRouted = createAI({ provider: "gemini", fallbackProviders: ["openai"], providers: slowGeminiProviders });
  const recovered = await slowGeminiRouted.generate("test prompt");
  assert.equal(recovered.provider, "openai");
  assert.deepEqual(slowGeminiCalls, ["gemini-1", "openai"], "a provider-wide 503 should not wait through each Gemini key slot");

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
  const permanentResult = await permanentRouted.generate("test prompt");
  assert.equal(permanentResult.provider, "openai");
  assert.deepEqual(permanentCalls, ["gemini-1", "openai"]);

  const emptyResponseCalls = [];
  const emptyResponseProviders = [
    provider("GEMINI_API_KEY_1", "gemini", async () => { emptyResponseCalls.push("gemini"); return { text: "   ", provider: "gemini" }; }),
    provider("OPENAI_API_KEY", "openai", async () => { emptyResponseCalls.push("openai"); return { text: "OpenAI answer", provider: "openai" }; }),
    provider("GROQ_API_KEY", "groq", async () => { emptyResponseCalls.push("groq"); return { text: "Groq answer", provider: "groq" }; })
  ];
  const emptyResponseRouted = createAI({ provider: "gemini", fallbackProviders: ["openai", "groq"], providers: emptyResponseProviders });
  const emptyResponseResult = await emptyResponseRouted.generate("test prompt");
  assert.equal(emptyResponseResult.provider, "openai");
  assert.equal(emptyResponseResult.text, "OpenAI answer");
  assert.deepEqual(emptyResponseCalls, ["gemini", "openai"]);

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

  // General routing stays on the primary provider when fallback is disabled.
  process.env.AI_PROVIDER = "openai";
  delete process.env.AI_FALLBACK_ENABLED;
  const disabledCalls = [];
  const disabled = createAI({ providers: [
    provider("OPENAI_API_KEY", "openai", async () => {
      disabledCalls.push("openai"); throw httpError(503);
    }),
    provider("GEMINI_API_KEY_1", "gemini", async () => {
      disabledCalls.push("gemini"); return { text: "unexpected", provider: "gemini" };
    })
  ] });
  await assert.rejects(disabled.generate("test prompt"));
  assert.deepEqual(disabledCalls, ["openai"]);

  // Enabling fallback adds configured providers and skips sibling keys on 503.
  process.env.AI_FALLBACK_ENABLED = "true";
  const fallbackCalls = [];
  const enabled = createAI({ providers: [
    provider("OPENAI_API_KEY", "openai", async () => {
      fallbackCalls.push("openai-1"); throw httpError(503);
    }),
    provider("OPENAI_API_KEY_2", "openai", async () => {
      fallbackCalls.push("openai-2"); return { text: "must skip", provider: "openai" };
    }),
    provider("GEMINI_API_KEY_1", "gemini", async () => {
      fallbackCalls.push("gemini"); return { text: "fallback answer", provider: "gemini" };
    }),
    provider("GROQ_API_KEY", "groq", async () => {
      fallbackCalls.push("groq"); return { text: "unused", provider: "groq" };
    })
  ] });
  const fallbackResult = await enabled.generate("test prompt");
  assert.equal(fallbackResult.provider, "gemini");
  assert.deepEqual(fallbackCalls, ["openai-1", "gemini"]);

  // A 401 tries the next key of the same provider before changing providers.
  const generalCredentialCalls = [];
  const credential = createAI({ providers: [
    provider("OPENAI_API_KEY", "openai", async () => {
      generalCredentialCalls.push("openai-1"); throw httpError(401, "invalid_api_key");
    }),
    provider("OPENAI_API_KEY_2", "openai", async () => {
      generalCredentialCalls.push("openai-2"); return { text: "recovered", provider: "openai" };
    }),
    provider("GEMINI_API_KEY_1", "gemini", async () => {
      generalCredentialCalls.push("gemini"); return { text: "unexpected", provider: "gemini" };
    })
  ] });
  const generalCredentialResult = await credential.generate("test prompt");
  assert.equal(generalCredentialResult.provider, "openai");
  assert.deepEqual(generalCredentialCalls, ["openai-1", "openai-2"]);

  console.log("AI provider routing and chemical fallback unit tests: OK");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
