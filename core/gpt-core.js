"use strict";
const { log, redactString } = require("./diagnostics");
const { normalizeArabic } = require("./normalization");

function isPotentialBotTask(input) {
  const s = normalizeArabic(input);
  return /(سعر|اسعار|بكام|بكم|جنيه|ج\s|(?:^|\s)ب\s*\d|العبوه|عبوه|علبه|كرتونه|مسحوق|منظف|منظفات|اريال|تايد|بريكس|اوكسي|بيرل|ليدر|قائمه|كتالوج|عروض|خصم|امازون|نون|جوميا|تاجر|محل|عنوان|تليفون|هاتف|واتساب|واتس)/i.test(s);
}

function deterministicType(input) {
  const s = normalizeArabic(input);
  // Common short greetings and social acknowledgements do not need an AI call.
  // Keep this deliberately narrow so useful questions are not silently ignored.
  if (s.length <= 100 && /^(?:(?:السلام عليكم|وعليكم السلام)(?: ورحمه الله وبركاته)?(?: اخ العرب)?|صباح الخير|مساء الخير|اهلا(?: وسهلا)?|مرحبا|ازيك(?: عامل ايه)?|كيف الحال|شكرا(?: جزيلا)?|متشكر(?: جدا)?|جزاك الله خيرا|بارك الله فيك|الله يبارك فيك|تمام|حاضر|بالتوفيق|الحمد لله)[.!؟?\s]*$/i.test(s)) return "other";
  if (/(كلور|مطهر|ماده|تركيبه|pH|حامض|حمض|قلوي|خلط)/i.test(s)) return "chemical";
  if (/(^|\s)\/قائمه|قائمه اسعار|قائمه شركة|قائمه شركه/i.test(s)) return "price_list";
  if (/(تاجر|محل|عنوان|تليفون|هاتف|واتساب|واتس)/i.test(s) && !/ج\s|جنيه/.test(s)) return "merchant";
  if (/(خصم|عرض|سعر خاص|amazon|امازون|نون|jumia|جوميا)/i.test(s)) return "deals";
  if (/(مسحوق|جيل|اريال|أريال|تايد|بريكس|اوكسي|أوكسي|بيرل|ليدر|سعر|جنيه|ج\s)/i.test(s)) return "price_observation";
  return isPotentialBotTask(s) ? null : "other";
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
      diagnostics({ module: "gpt-core", stage: "classify", severity: "error", status: "failed", input, details: { error: redactString(error?.message || "AI classification failed") }, durationMs: Date.now() - started, ...context });
      return { type: "other", confidence: 0, method: "fallback", error: { name: redactString(error?.name || "Error"), message: redactString(error?.message || "AI classification failed") } };
    }
  }
  return { classify, registry };
}
module.exports = { createGPTCore, deterministicType };
