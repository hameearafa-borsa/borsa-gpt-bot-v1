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
    const selectedModel = options.model || model || "gpt-6-luna";
    const body = {
      model: selectedModel,
      instructions: "أنت محرك GPT Core لبوت بورصة المنظفات. لا تخترع بيانات تجارية. أخرج المطلوب بدقة وبالعربية عند الحاجة.",
      input: String(prompt || "")
    };
    if (options.webSearch === true) {
      body.tools = [{ type: "web_search", search_context_size: "medium" }];
      body.tool_choice = "required";
      body.include = ["web_search_call.action.sources"];
    }
    const data = await requestJson("https://api.openai.com/v1/responses", body, { authorization: `Bearer ${key}` }, Number(options.timeoutMs) || undefined);
    let text = data.output_text || (data.output || []).flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text || "").join("");
    if (options.webSearch === true) {
      const sources = [];
      for (const item of data.output || []) {
        if (item.type !== "web_search_call") continue;
        for (const source of item.action?.sources || []) {
          const url = String(source.url || "");
          if (/^https:\/\//i.test(url) && !sources.some(entry => entry.url === url)) {
            sources.push({ title: String(source.title || new URL(url).hostname).slice(0, 120), url });
          }
        }
      }
      if (sources.length) text += "\n\nالمصادر التي استندت إليها:\n" + sources.slice(0, 5).map(source => `• ${source.title}: ${source.url}`).join("\n");
    }
    return { text, provider: "openai", model: selectedModel };
  };
}

function groqProvider(key, model) {
  return async (prompt, options = {}) => {
    const selectedModel = model || "qwen/qwen3.8-27b";
    const data = await requestJson("https://api.groq.com/openai/v1/chat/completions", {
      model: selectedModel,
      temperature: options.temperature ?? 0,
      messages: [
        { role: "system", content: "أنت محرك ذكاء اصطناعي مساعد لبوت بورصة المنظفات. اتبع تعليمات الطلب بدقة، وأجب بالعربية الواضحة عند الحاجة. لا تخترع نسبًا أو بيانات تجارية، واذكر مخاطر السلامة بوضوح عندما يكون السؤال كيميائيًا." },
        { role: "user", content: String(prompt || "") }
      ]
    }, { authorization: `Bearer ${key}` }, Number(options.timeoutMs) || undefined);
    return {
      text: data.choices?.[0]?.message?.content || "",
      provider: "groq",
      model: selectedModel
    };
  };
}

function isGeminiTransientError(error) {
  const message = String(error?.message || "");
  const status = providerStatus(error);
  return [408, 429, 500, 502, 503, 504].includes(status) ||
    /timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(message);
}

function isGeminiRetryableError(error) {
  // Retry only explicit temporary server-overload responses. 504/timeouts already
  // consume most of the request budget, while 429 may represent a quota limit.
  return [500, 502, 503].includes(providerStatus(error));
}

async function retryGeminiRequest(run, options = {}) {
  const maxAttempts = Math.max(1, Math.min(2, Number(options.maxAttempts) || 2));
  const baseDelayMs = Math.max(0, Math.min(1000, Number(options.delayMs ?? 350)));
  const maxDelayMs = Math.max(baseDelayMs, Math.min(1500, Number(options.maxDelayMs ?? 900)));
  const deadlineAt = Number(options.deadlineAt) || 0;
  const attemptTimeoutMs = Math.max(0, Number(options.attemptTimeoutMs) || 0);
  const random = typeof options.random === "function" ? options.random : Math.random;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isGeminiRetryableError(error)) throw error;
      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const jitterMs = exponentialDelay > 0 ? Math.floor(random() * Math.min(250, Math.ceil(exponentialDelay * 0.25))) : 0;
      const delayMs = exponentialDelay + jitterMs;
      const remainingMs = deadlineAt ? deadlineAt - Date.now() : Infinity;
      // Leave enough time for one complete next request plus a small safety margin.
      if (deadlineAt && remainingMs < attemptTimeoutMs + delayMs + 1000) throw error;
      options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, status: providerStatus(error) });
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function geminiProvider(key, model, { loadSdk = () => import("@google/genai"), timeoutMs = Math.max(1000, Math.min(12000, Number(process.env.GEMINI_TIMEOUT_MS || 12000))), fallbackModel = process.env.GEMINI_FALLBACK_MODEL || "" } = {}) {
  // Load the official SDK lazily so non-Gemini routes do not initialize it.
  // Keep one authenticated client per configured key for the life of this provider.
  let clientPromise;
  const getClient = () => {
    if (!clientPromise) {
      clientPromise = Promise.resolve()
        .then(loadSdk)
        .then(({ GoogleGenAI }) => {
          if (typeof GoogleGenAI !== "function") throw new Error("Gemini SDK did not export GoogleGenAI");
          return new GoogleGenAI({
            apiKey: key,
            httpOptions: {
              timeout: timeoutMs,
              // The app owns the bounded retry policy below; disable SDK retries
              // so two 12-second attempts remain inside Telegram's 30-second limit.
              retryOptions: { attempts: 1 }
            }
          });
        })
        .catch(error => {
          clientPromise = null;
          throw error;
        });
    }
    return clientPromise;
  };

  return async (prompt, options = {}) => {
    const selectedModel = model || process.env.GEMINI_MODEL || "gemini-3.8-flash";
    console.info(`[GEMINI_ROUTE] primary_model=${selectedModel} fallback_model=${fallbackModel || "disabled"}`);
    try {
      const initStartedAt = Date.now();
      let ai;
      try {
        ai = await getClient();
        console.info(`[GEMINI_CLIENT] outcome=ready duration_ms=${Date.now() - initStartedAt}`);
      } catch (error) {
        const status = providerStatus(error) || "unknown";
        console.warn(`[GEMINI_CLIENT] outcome=failed status=${status} retryable=${isGeminiTransientError(error)} duration_ms=${Date.now() - initStartedAt} error=${redactString(error?.message || "client_initialization_failed")}`);
        throw error;
      }
      const request = targetModel => ai.models.generateContent({
        model: targetModel,
        contents: String(prompt || ""),
        config: {
          automaticContinuation: false,
          ...(options.googleSearch === true ? { tools: [{ googleSearch: {} }] } : {})
        }
      });
      const runModel = async (stage, targetModel) => {
        const startedAt = Date.now();
        console.info(`[GEMINI_MODEL] stage=${stage} model=${targetModel} outcome=started`);
        try {
          const data = await request(targetModel);
          console.info(`[GEMINI_MODEL] stage=${stage} model=${targetModel} outcome=succeeded duration_ms=${Date.now() - startedAt}`);
          return data;
        } catch (error) {
          const status = providerStatus(error) || "unknown";
          const retryable = isGeminiTransientError(error);
          console.warn(`[GEMINI_MODEL] stage=${stage} model=${targetModel} outcome=failed status=${status} retryable=${retryable} duration_ms=${Date.now() - startedAt} error=${redactString(error?.message || "provider_error")}`);
          throw error;
        }
      };

      // One shared wall-clock budget covers the primary model, its bounded retry,
      // and the alternate model. No cross-provider fallback is enabled here.
      const configuredBudget = Number(options.requestBudgetMs) || Number(process.env.GEMINI_REQUEST_BUDGET_MS) || 26000;
      const requestBudgetMs = Math.max(timeoutMs, Math.min(28000, configuredBudget));
      const deadlineAt = Date.now() + requestBudgetMs;
      const retryOptions = stage => ({
        maxAttempts: 2,
        delayMs: 350,
        maxDelayMs: 900,
        deadlineAt,
        attemptTimeoutMs: timeoutMs,
        onRetry: event => console.info(
          `[GEMINI_RETRY] stage=${stage} model=${stage === "primary" ? selectedModel : fallbackModel} outcome=scheduled attempt=${event.attempt} next_attempt=${event.nextAttempt} status=${event.status} delay_ms=${event.delayMs}`
        )
      });
      const formatGroundedResult = (data, targetModel) => {
        let text = data?.text || "";
        const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const sources = [];
        for (const chunk of chunks) {
          const web = chunk?.web;
          const url = String(web?.uri || "");
          if (/^https:\/\//i.test(url) && !sources.some(source => source.url === url)) {
            sources.push({ title: String(web.title || new URL(url).hostname).slice(0, 120), url });
          }
        }
        if (sources.length) text += "\n\nمصادر البحث:\n" + sources.slice(0, 5).map(source => `• ${source.title}: ${source.url}`).join("\n");
        return { text, provider: "gemini", model: targetModel };
      };
      try {
        const data = await retryGeminiRequest(() => runModel("primary", selectedModel), retryOptions("primary"));
        return formatGroundedResult(data, selectedModel);
      } catch (primaryError) {
        if (!fallbackModel || fallbackModel === selectedModel || !isGeminiTransientError(primaryError)) {
          const reason = !fallbackModel ? "not_configured" : fallbackModel === selectedModel ? "same_as_primary" : "permanent_primary_error";
          console.info(`[GEMINI_FALLBACK] outcome=skipped reason=${reason} primary_model=${selectedModel} fallback_model=${fallbackModel || "disabled"}`);
          throw primaryError;
        }
        const remainingBudgetMs = deadlineAt - Date.now();
        if (remainingBudgetMs < timeoutMs + 1000) {
          console.info(`[GEMINI_FALLBACK] outcome=skipped reason=request_budget_exhausted remaining_ms=${Math.max(0, remainingBudgetMs)} primary_model=${selectedModel} fallback_model=${fallbackModel}`);
          throw primaryError;
        }
        console.info(`[GEMINI_FALLBACK] outcome=starting primary_model=${selectedModel} fallback_model=${fallbackModel}`);
        const data = await retryGeminiRequest(
          () => runModel("fallback", fallbackModel),
          retryOptions("fallback")
        );
        console.info(`[GEMINI_FALLBACK] outcome=succeeded primary_model=${selectedModel} fallback_model=${fallbackModel}`);
        return formatGroundedResult(data, fallbackModel);
      }
    } catch (error) {
      throw normalizeGeminiError(error);
    }
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
  const primary = String(process.env.AI_PROVIDER || "groq").toLowerCase();
  const order = [primary, ...["openai", "gemini", "groq"].filter(x => x !== primary)];
  return order.flatMap(provider => all[provider] || []);
}

function providerStatus(error) {
  const directStatus = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (Number.isInteger(directStatus) && directStatus >= 100 && directStatus <= 599) return directStatus;
  const message = String(error?.message || "");
  return Number(message.match(/AI HTTP (\d+)/)?.[1] || 0);
}

function normalizeGeminiError(error) {
  if (!error || typeof error !== "object") return error;
  const status = providerStatus(error);
  const message = redactString(String(error.message || "Gemini request failed").replace(/\s+/g, " ").slice(0, 350));
  if (!status || /^AI HTTP \d+/.test(message)) return error;
  const normalized = new Error(`AI HTTP ${status}: code=unknown; type=unknown; param=unknown; message=${message}`);
  normalized.status = status;
  normalized.cause = error;
  return normalized;
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
  // OpenAI is reserved for the chemical assistant. General callers default to
  // Groq and may explicitly allow Gemini as a fallback; environment flags must
  // never widen a route to include OpenAI.
  const configured = Array.isArray(options.providers) ? options.providers : providersFromEnv();
  const primaryProvider = String(options.provider || "groq").toLowerCase();
  const requestedFallbacks = Array.isArray(options.fallbackProviders)
    ? options.fallbackProviders
    : (options.provider ? [] : ["gemini"]);
  const fallbackProviders = [...new Set(requestedFallbacks.map(x => String(x).toLowerCase()))]
    .filter(provider => provider !== primaryProvider && (primaryProvider === "openai" || provider !== "openai"));
  const selected = [
    ...configured.filter(p => p.provider === primaryProvider),
    ...fallbackProviders.flatMap(provider => configured.filter(p => p.provider === provider))
  ];
  async function generate(prompt, options = {}) {
    if (!selected.length) throw new Error("لا يوجد مزود AI مضبوط");
    const allowCrossProvider = fallbackProviders.length > 0;
    const providerOrder = allowCrossProvider ? selected : selected.filter(p => p.provider === selected[0].provider);
    let last;
    let skipProvider = null;
    const requestBudgetMs = Math.max(0, Number(options.requestBudgetMs) || 0);
    const deadlineAt = requestBudgetMs ? Date.now() + requestBudgetMs : 0;
    for (let i = 0; i < providerOrder.length; i++) {
      const p = providerOrder[i];
      if (skipProvider === p.provider) continue;
      if (skipProvider && skipProvider !== p.provider) skipProvider = null;
      if (deadlineAt && deadlineAt - Date.now() <= 0) break;
      try {
        const attemptOptions = { ...options };
        if (deadlineAt) {
          const remainingMs = deadlineAt - Date.now();
          const configuredTimeoutMs = Math.max(1, Number(options.timeoutMs) || remainingMs);
          attemptOptions.timeoutMs = Math.max(1, Math.min(configuredTimeoutMs, remainingMs));
        }
        const result = await p.run(prompt, attemptOptions);
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
        // A timeout can be isolated to one OpenAI credential/connection path.
        // Try the next configured OpenAI key within the shared request budget;
        // keep skipping sibling keys for explicit provider-wide 5xx failures.
        const rotateOpenAIKeyAfterTimeout = p.provider === "openai" &&
          /AI timeout|ETIMEDOUT|timed? ?out/i.test(String(e?.message || ""));
        if ((isProviderWideFailure(e) && !rotateOpenAIKeyAfterTimeout) || (!retryable && !credentialError)) {
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

module.exports = { createAI, providersFromEnv, formatProviderError, retryGeminiRequest, isGeminiTransientError, isGeminiRetryableError, geminiProvider, providerStatus };
