"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const aiSource = fs.readFileSync(path.join(__dirname, "../core/ai.js"), "utf8");
const index = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const { createAI, providersFromEnv, retryGeminiRequest, geminiProvider, providerStatus } = require("../core/ai");

assert.ok(aiSource.includes("gemini-3.8-flash"));
assert.ok(aiSource.includes("process.env.GEMINI_TIMEOUT_MS || 12000"), "Gemini attempts stay within Telegraf handler budget");
assert.ok(aiSource.includes("retryGeminiRequest"), "Gemini retries one transient service failure");
assert.ok(aiSource.includes("maxAttempts = Math.max(1, Math.min(2"), "Gemini retry count is strictly bounded to two attempts");
assert.ok(aiSource.includes("timeout: timeoutMs"), "provider-specific timeouts must be honored");
assert.ok(geminiSection.includes('import("@google/genai")'), "Gemini requests must use the installed official SDK");
assert.ok(geminiSection.includes("new GoogleGenAI"));
assert.ok(geminiSection.includes("retryOptions: { attempts: 1 }"), "the SDK retry layer must not multiply the app retry budget");
const openAISection = aiSource.slice(aiSource.indexOf("function openAIProvider"), aiSource.indexOf("function groqProvider"));
assert.ok(openAISection.length > 0, "OpenAI provider implementation should exist");
assert.ok(!openAISection.includes("temperature:"), "Responses request must not send unsupported temperature field");
const geminiSection = aiSource.slice(aiSource.indexOf("function geminiProvider"), aiSource.indexOf("function providersFromEnv"));
assert.ok(geminiSection.length > 0, "Gemini provider implementation should exist");
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

const envNames = ["AI_PROVIDER", "AI_FALLBACK_ENABLED", "GEMINI_API_KEY", "GEMINI_API_KEY_1", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3"];
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
