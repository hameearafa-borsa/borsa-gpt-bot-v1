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
function isChemicalQuestion(value) {
  const s = String(value || "").trim();
  if (!s || s.length < 12 || /^\\//.test(s)) return false;

  // Price, availability, and sales chatter should never trigger the chemistry assistant.
  const commercialOnly = /(سعر|بكام|بكم|كام جنيه|جنيه لل|متوفر|متوفره|متوفر عند|عرض سعر|قائمة أسعار|قائمه اسعار|بيع|شراء|للبيع|للشراء|كرتونة|كرتونه|جملة|جمله|قطاعي|خصم|توصيل|محل|تاجر)/i.test(s);
  const technicalIntent = /(تركيب|تركيبة|تركيبات|تصنيع|أصنع|اصنع|اعمل|أعمل|طريقة عمل|طريقة تصنيع|خطوات التصنيع|نسب الخلط|نسبة الخلط|مكونات|مواد خام|خامات|تخفيف|تفاعل كيميائي|قياس pH|درجة الحموضة|درجة القلوية|اللزوجة|زيادة اللزوجة|قلة اللزوجة|تعكير|متعكر|انفصال الطبقات|ثبات المنتج|الرغوة|ضعف الرغوة|رائحة المنتج|تغير اللون|فساد المنتج|مشكلة في المنتج|حل مشكلة|بديل مادة|استبدال مادة|توافق المواد|جرعة المادة|تركيز المادة|هل يمكن خلط|هل ينفع خلط|خلط .* مع)/i.test(s);
  const explicitQuestion = /(كيف|ازاي|إزاي|ما هي طريقة|ما طريقة|ما سبب|لماذا|ليه|حل مشكلة|عندي مشكلة|عندي منتج|عايز أعمل|عاوز أعمل|محتاج تركيبة|محتاج طريقة|هل يمكن|هل ينفع|ما النسبة|كم نسبة|ما المكونات|ما التركيز)/i.test(s);
  if (commercialOnly && !technicalIntent) return false;
  return technicalIntent || (explicitQuestion && /(منظف|منظفات|صابون|شامبو|كلور|مطهر|معطر|فينيك|سلفونيك|صودا كاوية|هيدروكسيد|مادة كيميائية|مواد كيميائية)/i.test(s));
}
function buildPrompt(question) {
  return [
    "أنت المساعد الكيميائي المتخصص في تصنيع المنظفات لمجتمع بورصة المنظفات.",
    "أجب بالعربية الواضحة والعملية، وميّز بين الحقائق المؤكدة والافتراضات.",
    "عندما يكون ذلك مناسبًا وآمنًا، قدّم قسمين: تركيبة شعبية اقتصادية، وتركيبة أعلى جودة. لا تخترع نسبًا أو تركيزات أو خصائص غير موثقة.",
    "اذكر المواد والنسب ووحداتها وخطوات التصنيع وملاحظات الجودة وقياس pH واللزوجة فقط عندما تتوفر معلومات كافية وآمنة.",
    "إذا كانت الخامات أو تركيزاتها أو الاستخدام النهائي غير واضحة، اسأل عنها بدل التخمين. وضّح أن أي تركيبة جديدة تحتاج اختبارًا على عينة صغيرة واختبار ثبات وتوافق.",
    "لا تقدّم وصفات أو خطوات تشغيلية لخلطات خطرة، ولا تخلط المبيض/الكلور بالأحماض أو الأمونيا. لا تدّعِ أنك بحثت في قناة أو مصدر خارجي.",
    "أخرج محتوى الإجابة فقط دون إنشاء روابط؛ سيضيف البوت روابط القناة وGoogle وYouTube من قوالب ثابتة.",
    `السؤال: ${String(question || "").slice(0, 7000)}`
  ].join("\n");
}
async function answer(ai, question) {
  const gate = safetyGate(question);
  if (gate) return gate;
  if (!ai || typeof ai.generate !== "function") return SAFE_FALLBACK;
  try {
    const result = await ai.generate(buildPrompt(question), { temperature: 0.3 });
    return String(result?.text || "").trim() || SAFE_FALLBACK;
  } catch { return SAFE_FALLBACK; }
}
module.exports = { answer, buildPrompt, safetyGate, isChemicalQuestion, SAFE_FALLBACK, RULES };
