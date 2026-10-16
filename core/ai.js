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
      temperature: options.temperature ?? 0,
      instructions: "أنت محرك GPT Core لبوت بورصة المنظفات. لا تخترع بيانات تجارية. أخرج المطلوب بدقة وبالعربية عند الحاجة.",
      input: String(prompt || "")
    }, { authorization: `Bearer ${key}` });
    const text = data.output_text || (data.output || []).flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text || "").join("");
    return { text, provider: "openai", model: model || "gpt-6-luna" };
  };
}

function xaiProvider(key, model) {
  return async (prompt, options = {}) => {
    const data = await requestJson("https://api.x.ai/v1/chat/completions", {
      model: model || "grok-4.7",
      temperature: options.temperature ?? 0,
      messages: [{ role: "system", content: "أنت محرك GPT Core لبوت بورصة المنظفات. لا تخترع بيانات تجارية." }, { role: "user", content: prompt }]
    }, { authorization: `Bearer ${key}` });
    return { text: data.choices?.[0]?.message?.content || "", provider: "xai", model };
  };
}

function geminiProvider(key, model) {
  return async (prompt, options = {}) => {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || "gemini-2.5-flash")}:generateContent?key=${encodeURIComponent(key)}`;
    const data = await requestJson(endpoint, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: options.temperature ?? 0 }
    });
    return { text: data.candidates?.[0]?.content?.parts?.map(x => x.text || "").join("") || "", provider: "gemini", model };
  };
}

function providersFromEnv() {
  const out = [];
  for (const keyName of ["OPENAI_API_KEY", "OPENAI_API_KEY_2", "OPENAI_API_KEY_3"]) {
    if (process.env[keyName]) out.push({ name: keyName, run: openAIProvider(process.env[keyName], process.env.OPENAI_MODEL || "gpt-6-luna") });
  }
  for (const [keyName, modelName] of [["XAI_API_KEY","XAI_MODEL"],["XAI_API_KEY_2","XAI_MODEL"]]) {
    if (process.env[keyName]) out.push({ name: keyName, run: xaiProvider(process.env[keyName], process.env[modelName] || "grok-4.7") });
  }
  for (const keyName of ["GEMINI_API_KEY_1","GEMINI_API_KEY_2","GEMINI_API_KEY_3"]) {
    if (process.env[keyName]) out.push({ name: keyName, run: geminiProvider(process.env[keyName], process.env.GEMINI_MODEL || "gemini-2.5-flash") });
  }
  return out;
}

function createAI() {
  const providers = providersFromEnv();
  async function generate(prompt, options = {}) {
    let last;
    for (const p of providers) {
      try { return await p.run(prompt, options); }
      catch (e) { last = e; console.warn(`[AI_FAIL] ${p.name}: ${redactString(e?.message || "provider_error")}`); }
    }
    throw last || new Error("لا يوجد مزود AI مضبوط");
  }
  return { generate, providers: providers.map(x => x.name) };
}

module.exports = { createAI, providersFromEnv, formatProviderError };
