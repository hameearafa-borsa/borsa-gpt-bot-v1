"use strict";
const fs = require("node:fs");
const path = require("node:path");
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/chemical-rules.json"), "utf8")).rules;
const SAFE_FALLBACK = "أستطيع المساعدة في فهم المادة أو الاستخدام، لكن لا أنصح بخلط مواد كيميائية غير معروفة قبل معرفة الأسماء والتركيزات بدقة.";

function safetyGate(question) {
  const s = String(question || "").toLowerCase();
  const bleach = /(كلور|كلوركس|مبيض|ماء جافيل|هيبوكلوريت|هيبو كلوريت)/.test(s);
  const acids = /(حمض|حامض|فلاش|روح الملح|هيدروكلوريك|منظف حمضي|مزيل تكلس|خل)/.test(s);
  const ammonia = /(امونيا|أمونيا|نشادر|مادة امينية|مواد امينية|أمينيه|امينيه)/.test(s);
  if (bleach && acids) return "⚠️ تحذير سلامة: لا تخلط الكلور/المبيض مع الأحماض أو المنظفات الحمضية؛ قد تتولد غازات خطرة. لا أستطيع إعطاء خطوات خلط تشغيلية.";
  if (bleach && ammonia) return "⚠️ تحذير سلامة: لا تخلط الكلور/المبيض مع الأمونيا أو المواد الأمينية غير المؤكدة؛ قد تتولد أبخرة خطرة.";
  return null;
}
function isChemicalQuestion(value) {
  const s = String(value || "").trim();
  if (!s || s.length < 12 || s.startsWith("/")) return false;

  // A topic mention, link, or tutorial announcement alone is not a request for help.
  const commercialOnly = /(سعر|بكام|بكم|كام جنيه|جنيه لل|متوفر|متوفره|متوفر عند|عرض سعر|قائمة أسعار|قائمه اسعار|بيع|شراء|للبيع|للشراء|كرتونة|كرتونه|جملة|جمله|قطاعي|خصم|توصيل|محل|تاجر)/i.test(s);
  const technicalTopic = /(تركيب|تركيبة|تركيبات|تصنيع|طريقة عمل|طريقة تصنيع|خطوات التصنيع|نسب الخلط|نسبة الخلط|مكونات|مواد خام|خامات|تخفيف|تفاعل كيميائي|قياس pH|درجة الحموضة|درجة القلوية|اللزوجة|تعكير|متعكر|انفصال الطبقات|ثبات المنتج|الرغوة|ضعف الرغوة|ريحة|رائحة|تغير اللون|فساد المنتج|مشكلة|بديل مادة|استبدال مادة|توافق المواد|جرعة المادة|تركيز المادة|خلط)/i.test(s);
  const asksForHelp = /(كيف|ازاي|إزاي|ما هي طريقة|ما طريقة|ما سبب|لماذا|ليه|اعمل إيه|أعمل إيه|اعمل ايه|أعمل ايه|أعمل إيه|أعالج|علاج|حل مشكلة|عندي مشكلة|عندي منتج|عايز|عاوز|محتاج|ممكن حد|حد عنده|حد يعرف|هل يمكن|هل ينفع|ما النسبة|كم نسبة|ما المكونات|ما التركيز|ايه الحل|إيه الحل|ماذا أفعل|ماذا افعل)/i.test(s);
  const productContext = /(منظف|منظفات|صابون|شامبو|كلور|كلوركس|مطهر|معطر|داوني|داونى|فينيك|سلفونيك|صودا كاوية|هيدروكسيد|مادة كيميائية|مواد كيميائية|جيل شعر|سائل أطباق|سائل غسيل)/i.test(s);

  if (commercialOnly && !/(مشكلة|اللزوجة|تعكير|انفصال|ثبات|تغير اللون|تغير الرائحة|ريحة|رائحة)/i.test(s)) return false;
  // Require both technical content and a clear request/question to avoid replying to shared videos or general chatter.
  return technicalTopic && asksForHelp && (productContext || /(pH|اللزوجة|نسب الخلط|مكونات|مواد خام|خامات|توافق المواد|انفصال الطبقات|تغير اللون|ريحة|رائحة)/i.test(s));
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
async function answer(ai, question, onError = null) {
  const gate = safetyGate(question);
  if (gate) return gate;
  if (!ai || typeof ai.generate !== "function") {
    const error = new Error("Gemini AI provider is not configured");
    if (typeof onError === "function") { try { onError(error); } catch {} }
    return SAFE_FALLBACK;
  }
  try {
    const result = await ai.generate(buildPrompt(question), { temperature: 0.3 });
    return String(result?.text || "").trim() || SAFE_FALLBACK;
  } catch (error) {
    if (typeof onError === "function") { try { onError(error); } catch {} }
    return SAFE_FALLBACK;
  }
}
module.exports = { answer, buildPrompt, safetyGate, isChemicalQuestion, SAFE_FALLBACK, RULES };
