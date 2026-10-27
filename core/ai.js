"use strict";
const { redactString } = require("./diagnostics");

const https = require("node:https");

function requestJson(url, body, headers = {}, timeoutMs = Number(process.env.AI_TIMEOUT_MS || 20000)) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      timeout: timeoutMs,
    }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", c => { data += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed || {});
        reject(new Error(formatProviderError(res.statusCode, parsed?.error)));
      });
    });
    req.on("timeout", () => req.destroy(new Error("AI timeout")));
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}


function formatProviderError(statusCode, providerError) {
  const error = providerError && typeof providerError === "object" ? providerError : {};
  const clean = (value, fallback, max) => redactString(String(value || fallback).replace(/\s+/g, " ").slice(0, max));
  const code = clean(error.code, "unknown", 100);
  const type = clean(error.type, "unknown", 100);
  const param = clean(error.param, "unknown", 100);
  const message = clean(error.message, "No provider error message supplied", 350);
  return `AI HTTP ${Number(statusCode)}: code=${code}; type=${type}; param=${param}; message=${message}`;
}

function openAIProvider(key, model) {
  return async (prompt, options = {}) => {
    const data = await requestJson("https://api.openai.com/v1/responses", {
      model: model || "gpt-6-luna",
      instructions: "أنت محرك GPT Core لبوت بورصة المنظفات. لا تخترع بيانات تجارية. أخرج المطلوب بدقة وبالعربية عند الحاجة.",
      input: String(prompt || "")
    }, { authorization: `Bearer ${key}` });
    const text = data.output_text || (data.output || []).flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text || "").join("");
    return { text, provider: "openai", model: model || "gpt-6-luna" };
  };
}

function groqProvider(key, model) {
  return async (prompt, options = {}) => {
    const selectedModel = model || "qwen/qwen3.8-27b";
    const data = await requestJson("https://api.groq.com/openai/v1/chat/completions", {
      model: selectedModel,
      temperature: options.temperature ?? 0,
      messages: [
        { role: "system", content: "أنت المساعد الكيميائي لبوت بورصة المنظفات. أجب بالعربية الواضحة، لا تخترع نسبًا أو بيانات تجارية، واذكر مخاطر السلامة بوضوح." },
        { role: "user", content: String(prompt || "") }
      ]
    }, { authorization: `Bearer ${key}` });
    return {
      text: data.choices?.[0]?.message?.content || "",
      provider: "groq",
      model: selectedModel
    };
  };
}

function geminiProvider(key, model) {
  return async (prompt, options = {}) => {
    const selectedModel = model || "gemini-3.8-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`;
    // Gemini 3.8 Flash request intentionally omits sampling configuration.
    const data = await requestJson(endpoint, {
      contents: [{ role: "user", parts: [{ text: String(prompt || "") }] }]
    }, { "x-goog-api-key": key }, Number(process.env.GEMINI_TIMEOUT_MS || 45000));
    return { text: data.candidates?.[0]?.content?.parts?.map(x => x.text || "").join("") || "", provider: "gemini", model: selectedModel };
  };
}

function providersFromEnv() {
  const all = {
    openai: [], gemini: [], groq: []
  };
  for (const keyName of ["OPENAI_API_KEY", "OPENAI_API_KEY_2", "OPENAI_API_KEY_3"]) {
    if (process.env[keyName]) all.openai.push({ name: keyName, provider: "openai", run: openAIProvider(process.env[keyName], process.env.OPENAI_MODEL || "gpt-6-luna") });
  }
  // Accept the existing Railway variable GEMINI_API_KEY as slot 1, while
  // retaining GEMINI_API_KEY_1 for deployments that use the numbered convention.
  const geminiKeys = [
    ["GEMINI_API_KEY_1", process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY],
    ["GEMINI_API_KEY_2", process.env.GEMINI_API_KEY_2],
    ["GEMINI_API_KEY_3", process.env.GEMINI_API_KEY_3]
  ];
  for (const [keyName, key] of geminiKeys) {
    if (key) all.gemini.push({ name: keyName, provider: "gemini", run: geminiProvider(key, process.env.GEMINI_MODEL || "gemini-3.8-flash") });
  }

  for (const [keyName, modelName] of [["GROQ_API_KEY", "GROQ_MODEL"], ["GROQ_API_KEY_2", "GROQ_MODEL_2"]]) {
    if (process.env[keyName]) {
      all.groq.push({
        name: keyName,
        provider: "groq",
        run: groqProvider(process.env[keyName], process.env[modelName] || process.env.GROQ_MODEL || "qwen/qwen3.8-27b")
      });
    }
  }
  const primary = String(process.env.AI_PROVIDER || "openai").toLowerCase();
  const order = [primary, ...["openai", "gemini", "groq"].filter(x => x !== primary)];
  return order.flatMap(provider => all[provider] || []);
}

function providerStatus(error) {
  const message = String(error?.message || "");
  return Number(message.match(/AI HTTP (\d+)/)?.[1] || 0);
}

function isCredentialError(error) {
  const status = providerStatus(error);
  return status === 401 || status === 403 || /invalid_api_key|unauthorized|authentication failed/i.test(String(error?.message || ""));
}

function isRetryable(error) {
  const message = String(error?.message || "");
  const status = providerStatus(error);
  return status === 408 || status === 409 || status === 429 || status >= 500 || /timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(message);
}

// Timeouts and provider/server failures are usually shared by every key for the
// same model endpoint. Keep the full timeout for answer quality, but do not spend
// it repeatedly on sibling keys when a different provider can recover the request.
function isProviderWideFailure(error) {
  const message = String(error?.message || "");
  const status = providerStatus(error);
  return status === 408 || status >= 500 || /timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(message);
}

function createAI(options = {}) {
  // Optional provider injection supports deterministic unit tests; production defaults to environment configuration.
  const configured = Array.isArray(options.providers) ? options.providers : providersFromEnv();
  const forcedProvider = options.provider ? String(options.provider).toLowerCase() : null;
  const primaryProvider = forcedProvider || String(process.env.AI_PROVIDER || "openai").toLowerCase();
  const primary = configured.filter(p => p.provider === primaryProvider);
  const fallbackProviders = [...new Set((options.fallbackProviders || []).map(x => String(x).toLowerCase()))]
    .filter(provider => provider !== primaryProvider);
  const envFallbackEnabled = process.env.AI_FALLBACK_ENABLED === "true";
  // Explicit fallback providers remain ordered; environment-enabled fallback
  // adds all configured providers after the primary provider.
  const selected = forcedProvider
    ? [...primary, ...fallbackProviders.flatMap(provider => configured.filter(p => p.provider === provider))]
    : (primary.length
        ? (envFallbackEnabled
            ? [...primary, ...configured.filter(p => p.provider !== primaryProvider)]
            : primary)
        : configured);
  async function generate(prompt, options = {}) {
    if (!selected.length) throw new Error("لا يوجد مزود AI مضبوط");
    const allowCrossProvider = fallbackProviders.length > 0 || process.env.AI_FALLBACK_ENABLED === "true";
    const providerOrder = allowCrossProvider ? selected : selected.filter(p => p.provider === selected[0].provider);
    let last;
    let skipProvider = null;
    for (let i = 0; i < providerOrder.length; i++) {
      const p = providerOrder[i];
      if (skipProvider === p.provider) continue;
      if (skipProvider && skipProvider !== p.provider) skipProvider = null;
      try {
        const result = await p.run(prompt, options);
        if (!String(result?.text || "").trim()) {
          const error = new Error("AI provider returned an empty response");
          error.aiProvider = p.provider;
          throw error;
        }
        return result;
      }
      catch (e) {
        last = e;
        // Preserve the actual failing provider for safe diagnostics after all fallbacks fail.
        if (e && typeof e === "object") e.aiProvider = p.provider;
        const retryable = isRetryable(e);
        const credentialError = isCredentialError(e);
        console.warn(`[AI_FAIL] provider=${p.provider} key_slot=${p.name} retryable=${retryable} credential_error=${credentialError} error=${redactString(e?.message || "provider_error")}`);
        // Invalid credentials may be isolated to one key slot. Do not retry permanent
        // model/request errors across every key of the same provider.
        if (isProviderWideFailure(e) || (!retryable && !credentialError)) {
          if (!allowCrossProvider) throw e;
          skipProvider = p.provider;
        }
        const next = providerOrder.slice(i + 1).find(candidate => skipProvider ? candidate.provider !== skipProvider : true);
        if (!next) break;
        if (next.provider !== p.provider && !allowCrossProvider) break;
      }
    }
    throw last || new Error("لا يوجد مزود AI مضبوط");
  }
  return { generate, providers: selected.map(x => x.name), primaryProvider: selected[0]?.provider || null };
}

module.exports = { createAI, providersFromEnv, formatProviderError };
