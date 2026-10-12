"use strict";
const { log } = require("./diagnostics");
const { normalizeArabic } = require("./normalization");

function deterministicType(input) {
  const s = normalizeArabic(input);
  if (/(كلور|مطهر|ماده|تركيبه|pH|حامض|حمض|قلوي|خلط)/i.test(s)) return "chemical";
  if (/(^|\s)\/قائمه|قائمه اسعار|قائمه شركة|قائمه شركه/i.test(s)) return "price_list";
  if (/(تاجر|محل|عنوان|تليفون|هاتف|واتساب|واتس)/i.test(s) && !/ج\s|جنيه/.test(s)) return "merchant";
  if (/(خصم|عرض|سعر خاص|amazon|امازون|نون|jumia|جوميا)/i.test(s)) return "deals";
  if (/(مسحوق|جيل|اريال|أريال|تايد|بريكس|اوكسي|أوكسي|بيرل|ليدر|سعر|جنيه|ج\s)/i.test(s)) return "price_observation";
  return null;
}

function createGPTCore({ ai, registry, diagnostics = log }) {
  if (!ai || typeof ai.generate !== "function") throw new Error("GPT Core يحتاج ai.generate");
  async function classify(input, context = {}) {
    const deterministic = deterministicType(input);
    if (deterministic) return { type: deterministic, confidence: 0.9, method: "rules" };
    const started = Date.now();
    const prompt = ["أنت GPT Core لبوت بورصة المنظفات.", "أعد كلمة واحدة فقط: price_observation | price_list | merchant | chemical | moderation | deals | other.", "لا تنفذ قاعدة بيانات أو ترسل رسائل.", `النص: ${String(input || "").slice(0, 6000)}`].join("\n");
    try {
      const result = await ai.generate(prompt, { temperature: 0 });
      const type = String(result?.text || "").match(/price_observation|price_list|merchant|chemical|moderation|deals|other/)?.[0] || "other";
      diagnostics({ module: "gpt-core", stage: "classify", status: "ok", input, details: { type, provider: result?.provider }, durationMs: Date.now() - started, ...context });
      return { type, confidence: 0.75, method: "ai", raw: result };
    } catch (error) {
      diagnostics({ module: "gpt-core", stage: "classify", severity: "error", status: "failed", input, details: { error: error.message }, durationMs: Date.now() - started, ...context });
      return { type: "other", confidence: 0, method: "fallback", error };
    }
  }
  return { classify, registry };
}
module.exports = { createGPTCore, deterministicType };
