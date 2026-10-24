"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const aiSource = fs.readFileSync(path.join(__dirname, "../core/ai.js"), "utf8");
const index = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const { createAI, extractResponsesText, providersFromEnv } = require("../core/ai");

assert.ok(aiSource.includes("gemini-3.5-flash-lite"));
assert.ok(aiSource.includes("x-goog-api-key"));
const openAISection = aiSource.slice(aiSource.indexOf("function openAIProvider"), aiSource.indexOf("function extractResponsesText"));
assert.ok(openAISection.length > 0, "OpenAI provider implementation should exist");
assert.ok(!openAISection.includes("temperature:"), "Responses request must not send unsupported temperature field");
const geminiSection = aiSource.slice(aiSource.indexOf("function geminiProvider"), aiSource.indexOf("function providersFromEnv"));
assert.ok(geminiSection.length > 0, "Gemini provider implementation should exist");
assert.ok(!geminiSection.includes("temperature"), "Gemini 3.5 Flash-Lite request must omit deprecated temperature sampling parameter");
assert.ok(!geminiSection.includes("generationConfig"), "Gemini request should omit deprecated sampling configuration");
assert.ok(aiSource.includes('AI_FALLBACK_ENABLED === "true"'));
assert.ok(aiSource.includes("function isCredentialError"));
assert.ok(aiSource.includes("fallbackProviders.flatMap"));
assert.ok(aiSource.includes("https://api.x.ai/v1/responses"));
assert.ok(!aiSource.includes("https://api.x.ai/v1/chat/completions"));
assert.ok(aiSource.includes("if (!retryable && !credentialError)"));
assert.ok(aiSource.includes("https://api.groq.com/openai/v1/chat/completions"));
assert.ok(aiSource.includes("GROQ_MODEL"));
assert.ok(aiSource.includes("GROQ_API_KEY_2"));
assert.ok(index.includes('createAI({ provider: "gemini", fallbackProviders: ["openai", "groq"] })'));

function provider(name, providerName, run) {
  return { name, provider: providerName, run };
}
function httpError(status, message = "simulated provider failure") {
  return new Error(`AI HTTP ${status}: ${message}`);
}

assert.equal(extractResponsesText({ output_text: "direct answer" }), "direct answer");
assert.equal(extractResponsesText({ output: [
  { type: "reasoning", summary: [{ text: "not user-facing answer" }] },
  { type: "message", content: [{ type: "output_text", text: "nested answer" }] }
] }), "nested answer");
assert.equal(extractResponsesText({ output: [] }), "");

const envNames = ["AI_PROVIDER", "GEMINI_API_KEY", "GEMINI_API_KEY_1", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3"];
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
  assert.deepEqual(calls, ["gemini-1", "gemini-2", "openai", "groq"]);

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

  console.log("AI provider routing and chemical fallback unit tests: OK");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
