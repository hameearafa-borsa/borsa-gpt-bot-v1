"use strict";
const { redactString } = require("./diagnostics");

const https = require("node:https");

function requestJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      timeout: Number(process.env.AI_TIMEOUT_MS || 20000),
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

function xaiProvider(key, model) {
  return async (prompt) => {
    const data = await requestJson("https://api.x.ai/v1/chat/completions", {
      model: model || "grok-4.7",
      messages: [{ role: "system", content: "أنت محرك GPT Core لبوت بورصة المنظفات. لا تخترع بيانات تجارية." }, { role: "user", content: prompt }]
    }, { authorization: `Bearer ${key}` });
    return { text: data.choices?.[0]?.message?.content || "", provider: "xai", model };
  };
}

const WORKING_GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"];

function geminiModelOrder(preferred) {
  const models = [];
  const add = (model) => {
    const name = String(model || "").trim();
    if (name && !models.includes(name)) models.push(name);
  };
  if (WORKING_GEMINI_MODELS.includes(String(preferred || "").trim())) add(preferred);
  for (const model of WORKING_GEMINI_MODELS) add(model);
  add(preferred);
  return models;
}

function geminiProvider(key, model) {
  return async (prompt) => {
    let last;
    for (const selectedModel of geminiModelOrder(model)) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`;
      try {
        const data = await requestJson(endpoint, {
          contents: [{ role: "user", parts: [{ text: prompt }] }]
        }, { "x-goog-api-key": key });
        return { text: data.candidates?.[0]?.content?.parts?.map(x => x.text || "").join("") || "", provider: "gemini", model: selectedModel };
      } catch (error) {
        last = error;
        const message = String(error?.message || "");
        const missing = /AI HTTP 404/.test(message) || /not found|not supported|unknown model/i.test(message);
        if (!missing) throw error;
      }
    }
    throw last || new Error("gemini_model_unavailable");
  };
}

function providersFromEnv() {
  const all = {
    openai: [], xai: [], gemini: []
  };
  for (const keyName of ["OPENAI_API_KEY", "OPENAI_API_KEY_2", "OPENAI_API_KEY_3"]) {
    if (process.env[keyName]) all.openai.push({ name: keyName, provider: "openai", run: openAIProvider(process.env[keyName], process.env.OPENAI_MODEL || "gpt-6-luna") });
  }
  for (const [keyName, modelName] of [["XAI_API_KEY","XAI_MODEL"],["XAI_API_KEY_2","XAI_MODEL_2"]]) {
    if (process.env[keyName]) all.xai.push({ name: keyName, provider: "xai", run: xaiProvider(process.env[keyName], process.env[modelName] || process.env.XAI_MODEL || "grok-4.7") });
  }
  for (const keyName of ["GEMINI_API_KEY", "GEMINI_API_KEY_1", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3"]) {
    if (process.env[keyName]) all.gemini.push({ name: keyName, provider: "gemini", run: geminiProvider(process.env[keyName], process.env.GEMINI_MODEL || "gemini-3.8-flash") });
  }
  const primary = String(process.env.AI_PROVIDER || "openai").toLowerCase();
  const order = [primary, ...["openai", "gemini", "xai"].filter(x => x !== primary)];
  return order.flatMap(provider => all[provider] || []);
}

function isRetryable(error) {
  const message = String(error?.message || "");
  const status = Number(message.match(/AI HTTP (\d+)/)?.[1] || 0);
  return status === 408 || status === 409 || status === 429 || status >= 500 || /timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(message);
}

function createAI() {
  const configured = providersFromEnv();
  const primaryProvider = String(process.env.AI_PROVIDER || "openai").toLowerCase();
  const primary = configured.filter(p => p.provider === primaryProvider);
  const selected = primary.length ? primary : configured;
  async function generate(prompt, options = {}) {
    if (!selected.length) throw new Error("لا يوجد مزود AI مضبوط");
    const allowCrossProvider = process.env.AI_FALLBACK_ENABLED === "true";
    const providerOrder = allowCrossProvider ? selected : selected.filter(p => p.provider === selected[0].provider);
    let last;
    for (let i = 0; i < providerOrder.length; i++) {
      const p = providerOrder[i];
      try { return await p.run(prompt, options); }
      catch (e) {
        last = e;
        console.warn(`[AI_FAIL] provider=${p.provider} key_slot=${p.name} retryable=${isRetryable(e)} error=${redactString(e?.message || "provider_error")}`);
        // Do not burn through keys/providers on invalid credentials, unsupported models,
        // or malformed requests. Retry only temporary/rate-limit failures.
        if (!isRetryable(e)) throw e;
        const next = providerOrder[i + 1];
        if (next && next.provider !== p.provider && !allowCrossProvider) break;
      }
    }
    throw last || new Error("لا يوجد مزود AI مضبوط");
  }
  return { generate, providers: selected.map(x => x.name), primaryProvider: selected[0]?.provider || null };
}

module.exports = { createAI, providersFromEnv, formatProviderError, geminiModelOrder, WORKING_GEMINI_MODELS };
