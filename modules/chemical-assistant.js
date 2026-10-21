"use strict";
const fs = require("node:fs");
const path = require("node:path");
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/chemical-rules.json"), "utf8")).rules;
const SAFE_FALLBACK = "أستطيع المساعدة في فهم المادة أو الاستخدام، لكن لا أنصح بخلط مواد كيميائية غير معروفة قبل معرفة الأسماء والتركيزات بدقة.";

function safetyGate(question) {
  const s = String(question || "").toLowerCase();
  if (/(كلور|مبيض|هيبوكلوريت)/.test(s) && /(حمض|حامض|فلاش|منظف حمضي|خل)/.test(s)) return "⚠️ تحذير سلامة: لا تخلط الكلور/المبيض مع الأحماض أو المنظفات الحمضية؛ قد تتولد غازات خطرة. لا أستطيع إعطاء خطوات خلط تشغيلية.";
  if (/(كلور|مبيض|هيبوكلوريت)/.test(s) && /(امونيا|أمونيا|نشادر|مادة امينية|امينيه)/.test(s)) return "⚠️ تحذير سلامة: لا تخلط الكلور/المبيض مع الأمونيا أو المواد الأمينية غير المؤكدة؛ قد تتولد أبخرة خطرة.";
  return null;
}
function buildPrompt(question) {
  return [
    "أنت المساعد الكيميائي لبوت بورصة المنظفات.",
    "أجب بالعربية وبشكل عملي ومختصر.",
    "لا تخترع تركيبة أو تركيزًا أو خاصية غير مذكورة.",
    "إذا كانت المعلومات ناقصة اطلب الاسم والتركيز وظروف الاستخدام.",
    "لا تقدم وصفات خلط خطرة أو خطوات تشغيلية قد تسبب أذى.",
    `السؤال: ${String(question || "").slice(0, 7000)}`
  ].join("\n");
}
async function answer(ai, question) {
  const gate = safetyGate(question);
  if (gate) return gate;
  if (!ai || typeof ai.generate !== "function") return SAFE_FALLBACK;
  try {
    const result = await ai.generate(buildPrompt(question), { temperature: 0.1 });
    return String(result?.text || "").trim() || SAFE_FALLBACK;
  } catch { return SAFE_FALLBACK; }
}
module.exports = { answer, buildPrompt, safetyGate, SAFE_FALLBACK, RULES };
