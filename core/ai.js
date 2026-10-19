"use strict";
const { redactString } = require("./diagnostics");
const https = require("node:https");

const SYSTEM = "أنت محرك GPT Core لبوت بورصة المنظفات. لا تخترع بيانات تجارية. أخرج المطلوب بدقة وبالعربية عند الحاجة.";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function samplingAllowed(model) {
  // GPT-5/GPT-6 and Grok 4 reasoning models reject a custom temperature unless reasoning is off.
  return !/^(?:gpt-5|gpt-6|o\d|grok-4)/i.test(String(model || ""));
}

function responsesBody(model, prompt, options = {}) {
  const body = {
    model,
    instructions: SYSTEM,
    input: String(prompt || ""),
    max_output_tokens: Number(options.maxOutputTokens || 1200),
  };
  if (/^(?:gpt-5|gpt-6|o\d|grok-)/i.test(String(model || ""))) {
    body.reasoning = { effort: options.reasoningEffort || "low" };
  }
  if (options.temperature != null && samplingAllowed(model) && body.reasoning?.effort !== "low" && body.reasoning?.effort !== "medium" && body.reasoning?.effort !== "high") {
    body.temperature = options.temperature;
  }
  if (options.json) body.text = { format: { type: "json_object" } };
  return body;
}

function xaiResponsesBody(model, prompt, options = {}) {
  return {
    model,
    input: [{ role: "user", content: `${SYSTEM}\n\n${String(prompt || "")}` }],
    max_output_tokens: Number(options.maxOutputTokens || 1200),
    reasoning: { effort: options.reasoningEffort || "low" },
  };
}

function chatBody(model, prompt, options = {}) {
  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: String(prompt || "") },
    ],
  };
  if (options.maxOutputTokens) body.max_tokens = Number(options.maxOutputTokens);
  if (options.temperature != null && samplingAllowed(model)) body.temperature = options.temperature;
  return body;
}

function textFromResponses(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  const parts = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" || part?.type === "text") parts.push(part.text || "");
    }
    if (!item?.content && typeof item?.text === "string") parts.push(item.text);
  }
  return parts.join("");
}

function textFromChat(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
  return "";
}

function requestJson(url, body, headers = {}, options = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  const timeout = Number(options.timeoutMs || process.env.AI_TIMEOUT_MS || 20000);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(payload.length),
        accept: "application/json",
        "user-agent": "borsa-gpt-bot/1.0",
        ...headers,
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed || {});
        const err = new Error(formatProviderError(res.statusCode, parsed?.error));
        err.statusCode = res.statusCode;
        err.param = parsed?.error?.param || null;
        reject(err);
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("AI timeout"), { statusCode: 408 })));
    req.on("error", reject);
    req.end(payload);
  });
}

function unsupportedParameter(err) {
  return err?.statusCode === 400 && /temperature|top_p|reasoning|unsupported_value|unsupported_parameter|unknown parameter|invalid parameter/i.test(String(err.message || ""));
}

function endpointMissing(err) {
  return err?.statusCode === 404 || err?.statusCode === 405 || /not found|unknown url|unrecognized request/i.test(String(err.message || ""));
}

async function requestWithRecovery(url, body, headers, options) {
  try { return await requestJson(url, body, headers, options); }
  catch (err) {
    if (unsupportedParameter(err)) {
      const slim = {
        model: body.model,
        input: body.input,
        instructions: body.instructions,
        messages: body.messages,
        max_output_tokens: body.max_output_tokens,
        max_tokens: body.max_tokens,
      };
      const compact = Object.fromEntries(Object.entries(slim).filter(([, value]) => value != null));
      return requestJson(url, compact, headers, options);
    }
    if ([429, 500, 502, 503, 504].includes(err.statusCode)) {
      await sleep(700);
      return requestJson(url, body, headers, options);
    }
    throw err;
  }
}

function formatProviderError(statusCode, providerError) {
  const error = providerError && typeof providerError === "object" ? providerError : {};
  const clean = (value, fallback, max) => redactString(String(value || fallback).replace(/\s+/g, " ").slice(0, max));
  const code = clean(error.code, "unknown", 100);
  const type = clean(error.type || error.status, "unknown", 100);
  const param = clean(error.param, "unknown", 100);
  const message = clean(error.message, "No provider error message supplied", 350);
  return `AI HTTP ${Number(statusCode)}: code=${code}; type=${type}; param=${param}; message=${message}`;
}

async function completeResponses({ responsesUrl, chatUrl, key, model, prompt, options, provider, xai = false }) {
  const headers = { authorization: `Bearer ${key}` };
  const primaryBody = xai ? xaiResponsesBody(model, prompt, options) : responsesBody(model, prompt, options);
  try {
    const data = await requestWithRecovery(responsesUrl, primaryBody, headers, options);
    const text = textFromResponses(data);
    if (text.trim() || !chatUrl) return { text, provider, model, endpoint: "responses" };
  } catch (err) {
    if (!endpointMissing(err) && !unsupportedParameter(err)) throw err;
  }
  const data = await requestWithRecovery(chatUrl, chatBody(model, prompt, options), headers, options);
  return { text: textFromChat(data), provider, model, endpoint: "chat" };
}

function openAIProvider(key, model) {
  return (prompt, options = {}) => completeResponses({
    responsesUrl: "https://api.openai.com/v1/responses",
    chatUrl: "https://api.openai.com/v1/chat/completions",
    key, model: model || "gpt-6-luna", prompt, options, provider: "openai",
  });
}

function xaiProvider(key, model) {
  return (prompt, options = {}) => completeResponses({
    responsesUrl: "https://api.x.ai/v1/responses",
    chatUrl: "https://api.x.ai/v1/chat/completions",
    key, model: model || "grok-4.7", prompt, options, provider: "xai", xai: true,
  });
}

function geminiProvider(key, model) {
  return async (prompt, options = {}) => {
    const usedModel = model || "gemini-2.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(usedModel)}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents: [{ role: "user", parts: [{ text: `${SYSTEM}\n\n${String(prompt || "")}` }] }],
      generationConfig: { maxOutputTokens: Number(options.maxOutputTokens || 1200) },
    };
    let data;
    try { data = await requestWithRecovery(endpoint, body, {}, options); }
    catch (err) {
      if (!unsupportedParameter(err)) throw err;
      data = await requestJson(endpoint, { contents: body.contents }, {}, options);
    }
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
    if (!text && data.promptFeedback?.blockReason) {
      throw new Error(`AI HTTP 200: code=blocked; type=gemini; param=prompt; message=${redactString(String(data.promptFeedback.blockReason))}`);
    }
    return { text, provider: "gemini", model: usedModel, endpoint: "generateContent" };
  };
}

function providersFromEnv() {
  const out = [];
  for (const keyName of ["OPENAI_API_KEY", "OPENAI_API_KEY_2"]) {
    if (process.env[keyName]) out.push({ name: keyName, run: openAIProvider(process.env[keyName], process.env.OPENAI_MODEL || "gpt-6-luna") });
  }
  for (const keyName of ["XAI_API_KEY", "XAI_API_KEY_2"]) {
    if (process.env[keyName]) out.push({ name: keyName, run: xaiProvider(process.env[keyName], process.env.XAI_MODEL || "grok-4.7") });
  }
  for (const keyName of ["GEMINI_API_KEY_1", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3"]) {
    if (process.env[keyName]) out.push({ name: keyName, run: geminiProvider(process.env[keyName], process.env.GEMINI_MODEL || "gemini-2.5-flash") });
  }
  return out;
}

function createAI() {
  const providers = providersFromEnv();
  async function generate(prompt, options = {}) {
    const budget = Number(options.budgetMs || process.env.AI_BUDGET_MS || 45000);
    const started = Date.now();
    let last;
    for (const provider of providers) {
      const elapsed = Date.now() - started;
      if (elapsed >= budget) break;
      const timeoutMs = Math.max(5000, Math.min(Number(process.env.AI_TIMEOUT_MS || 20000), budget - elapsed));
      try { return await provider.run(prompt, { ...options, timeoutMs }); }
      catch (err) {
        last = err;
        console.warn(`[AI_FAIL] ${provider.name}: ${redactString(err?.message || "provider_error")}`);
      }
    }
    throw last || new Error("لا يوجد مزود AI مضبوط");
  }
  return { generate, providers: providers.map((item) => item.name) };
}

module.exports = {
  createAI,
  providersFromEnv,
  formatProviderError,
  responsesBody,
  xaiResponsesBody,
  chatBody,
  samplingAllowed,
  textFromResponses,
  textFromChat,
};
