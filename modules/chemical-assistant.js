"use strict";
const fs = require("node:fs");
const path = require("node:path");
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/chemical-rules.json"), "utf8")).rules;
const SAFE_FALLBACK = "تعذر إعداد إجابة فنية موثوقة الآن. أرسل سؤالك مرة أخرى، وسأساعدك مع توضيح أي بيانات ناقصة قبل تحديد النسب أو خطوات الخلط.";
const SERVICE_UNAVAILABLE_FALLBACK = "خدمة المساعد الكيميائي مشغولة أو غير متاحة مؤقتًا الآن. لم يتم رفض سؤالك أو اعتبار الخامات غير واضحة؛ حاول إرسال السؤال مرة أخرى بعد قليل. لا تبدأ خلطًا جديدًا قبل التأكد من التركيبة والتركيزات.";
const SERVICE_CONFIG_FALLBACK = "يوجد عطل مؤقت في إعداد الاتصال بخدمة المساعد الكيميائي. لم يتم تقييم تركيبتك بعد؛ يرجى المحاولة لاحقًا.";

function getProviderFallback(error) {
  const message = String(error?.message || error || "");
  const status = Number(message.match(/AI HTTP (\d+)/)?.[1] || 0);
  if ([408, 429, 500, 502, 503, 504].includes(status) ||
      /timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|overloaded|temporarily unavailable/i.test(message)) {
    return SERVICE_UNAVAILABLE_FALLBACK;
  }
  if ([401, 403].includes(status) || /invalid_api_key|unauthorized|authentication failed/i.test(message)) {
    return SERVICE_CONFIG_FALLBACK;
  }
  return SAFE_FALLBACK;
}
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
function buildConversationInput(message, currentText = null) {
  const current = String(currentText ?? message?.text ?? message?.caption ?? "").trim();
  const previousUserMessages = [];
  let cursor = message?.reply_to_message || null;
  let hasChemicalAssistantReply = false;
  let depth = 0;
  while (cursor && depth < 8) {
    const text = String(cursor.text || cursor.caption || "").trim();
    if (cursor.from?.is_bot && /🧪\s*المساعد الكيميائي/.test(text)) hasChemicalAssistantReply = true;
    if (!cursor.from?.is_bot && text) previousUserMessages.unshift(text);
    cursor = cursor.reply_to_message || null;
    depth++;
  }
  if (!hasChemicalAssistantReply) return current.slice(0, 7000);
  return [...previousUserMessages, current].filter(Boolean).join("\n\n").slice(0, 7000);
}
async function ensureConversationContextSchema(pool) {
  if (!pool) throw new Error("chemical conversation context requires PostgreSQL");
  await pool.query(`CREATE TABLE IF NOT EXISTS chemical_conversation_contexts (
    chat_id BIGINT NOT NULL,
    assistant_message_id BIGINT NOT NULL,
    context_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(chat_id, assistant_message_id)
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_chemical_conversation_contexts_created ON chemical_conversation_contexts(created_at)");
}
async function resolveConversationInput(pool, message, currentText = null) {
  const current = String(currentText ?? message?.text ?? message?.caption ?? "").trim();
  const reply = message?.reply_to_message;
  if (pool && reply?.from?.is_bot && /🧪\s*المساعد الكيميائي/.test(String(reply.text || reply.caption || ""))) {
    const result = await pool.query(`SELECT context_text FROM chemical_conversation_contexts
      WHERE chat_id=$1 AND assistant_message_id=$2
        AND created_at >= NOW() - INTERVAL '30 days'`,
      [message?.chat?.id, reply.message_id]);
    const previous = String(result.rows?.[0]?.context_text || "").trim();
    if (previous) return [previous, current].filter(Boolean).join("\n\n").slice(0, 7000);
  }
  return buildConversationInput(message, current);
}
async function saveConversationContext(pool, { chatId, assistantMessageId, contextText }) {
  if (!pool || !chatId || !assistantMessageId || !String(contextText || "").trim()) return false;
  await pool.query(`INSERT INTO chemical_conversation_contexts(chat_id,assistant_message_id,context_text)
    VALUES($1,$2,$3) ON CONFLICT(chat_id,assistant_message_id)
    DO UPDATE SET context_text=EXCLUDED.context_text, created_at=NOW()`,
    [chatId, assistantMessageId, String(contextText).slice(0, 7000)]);
  await pool.query("DELETE FROM chemical_conversation_contexts WHERE created_at < NOW() - INTERVAL '30 days'");
  return true;
}
function buildPrompt(question) {
  const safetyRules = RULES.map(rule => "- " + rule.key + ": " + rule.trigger + " — " + rule.action).join("\n");
  const marketNames = [
    "افهم أسماء الخامات الدارجة في السوق المصري ولا تطلب من المستخدم تحويلها إلى أسماء علمية لمجرد اختلاف التسمية.",
    "أمثلة استرشادية: تكسابون أو N70 غالبًا SLES؛ سلفونيك أو LABSA غالبًا حمض ألكيل بنزين سلفونيك الخطي؛ بيتائين غالبًا Cocamidopropyl Betaine؛ صودا كاوية هي هيدروكسيد الصوديوم؛ ملح الطعام هو كلوريد الصوديوم؛ جلسرين هو Glycerol؛ وCMC هو كربوكسي ميثيل سليلوز.",
    "هذه مطابقة أولية للأسماء التجارية وليست ضمانًا لهوية كل مورد: كمبرلان وتيلوز وبعض الأسماء التجارية قد تختلف مواصفاتها؛ اقبل الاسم المتداول واطلب صورة الملصق أو التركيز فقط إذا كان الاختلاف يغيّر السلامة أو الحساب.",
    "لا تطلب الاسم العلمي من المستخدم إذا كان الاسم التجاري معروفًا بما يكفي. لا تطلب إعادة كتابة الخامات التي ذكرها في الرسائل السابقة.",
    "إذا كانت الرسالة ردًا على إجابة سابقة، اعتبر رسائل المستخدم السابقة المرفقة جزءًا من نفس المحادثة، وادمجها بدل البدء من الصفر.",
    "لا تطرح قائمة طويلة من الأسئلة. اسأل سؤالًا توضيحيًا واحدًا فقط إذا كانت معلومة أساسية تمنع اختيار التركيبة، مثل هل المنتج سائل أطباق أم صابون يدين أم سائل غسيل.",
    "عند توافر المعلومات، قدّم إجابة عملية مباشرة: جدول تركيبة مبدئية محسوبة على 100 كجم، اسم الخامة المتداول، وظيفتها، النسبة والكمية، ثم ترتيب الإضافة وطريقة التصنيع وضبط pH واللزوجة واختبارات الجودة.",
    "ميّز بين نسبة المادة التجارية كما تُشترى ونسبة المادة الفعالة. اذكر افتراضات التركيز بوضوح، ولا تخترع مواصفة مورد أو نسبة لا يمكن تبريرها.",
    "لا تعد المستخدم بجودة تضاهي الشركات لمجرد الوصفة؛ اشرح أن الوصول إليها يتطلب اختبار تنظيف ورغوة وثبات وميكروبيولوجي وتوافق العبوة ومراجعة التكلفة.",
    "إذا نقص تركيز خامة مؤثرة، لا ترفض السؤال كله: قدم ما يمكن تأكيده واسأل عن التركيز أو الدرجة التجارية المحددة فقط.",
  ].join("\n");
  return [
    "أنت مستشار فني متخصص في تصنيع المنظفات التجارية للسوق المصري، وتخاطب أصحاب الورش والمحلات بلغة عربية مصرية واضحة ومحترمة.",
    "كن عمليًا ومباشرًا، ولا تتعامل مع المستخدم كطالب كيمياء مطالب بحفظ الأسماء العلمية. ابدأ بفهم هدف المنتج والخامات المتاحة.",
    marketNames,
    "عندما تسمح المعلومات، قدّم تركيبة شعبية اقتصادية وتركيبة أعلى جودة؛ وإذا كانت البيانات لا تكفي، اسأل سؤالًا واحدًا فقط. لا تكرر السؤال ولا تتهرب بطلب قائمة الخامات إذا كانت موجودة في نص المحادثة.",
    "اذكر خطوات التشغيل بالتسلسل، واحتياطات التعامل مع الصودا الكاوية والمواد المركزة، ولا تقدّم خلطات خطرة. لا تخلط الكلور/المبيض بالأحماض أو الأمونيا.",
    "قواعد السلامة المحلية الملزمة:\n" + safetyRules,
    "إذا لم تكن لديك بيانات موثوقة تكفي لنسبة محددة، قل ذلك بوضوح ولا تخترعها. لا تدّعِ أنك بحثت في مصدر خارجي.",
    "أخرج محتوى الإجابة فقط دون إنشاء روابط؛ سيضيف البوت روابط القناة وGoogle وYouTube من قوالب ثابتة.",
    "سؤال المستخدم وسياق رسائله السابقة:\n" + String(question || "").slice(0, 7000)
  ].join("\n");
}
async function answer(ai, question, onError = null) {
  const gate = safetyGate(question);
  if (gate) return gate;
  if (!ai || typeof ai.generate !== "function") {
    const error = new Error("Gemini AI provider is not configured");
    if (typeof onError === "function") { try { onError(error); } catch {} }
    return SERVICE_CONFIG_FALLBACK;
  }
  try {
    const result = await ai.generate(buildPrompt(question), { temperature: 0.3 });
    const answerText = String(result?.text || "").trim();
    if (!answerText) return SAFE_FALLBACK;
    // Identify the engine that actually returned this answer; never label it GPT by default.
    const provider = String(result?.provider || "").toLowerCase();
    const providerLabel = provider.includes("groq") ? "Groq"
      : provider.includes("gemini") ? "Gemini"
      : provider.includes("openai") ? "OpenAI"
      : provider.includes("openrouter") ? "OpenRouter"
      : "";
    return providerLabel ? `🤖 الخدمة مقدمة بتقنيات ${providerLabel}\n\n${answerText}` : answerText;
  } catch (error) {
    if (typeof onError === "function") { try { onError(error); } catch {} }
    return getProviderFallback(error);
  }
}
module.exports = { answer, buildPrompt, buildConversationInput, ensureConversationContextSchema, resolveConversationInput, saveConversationContext, safetyGate, isChemicalQuestion, getProviderFallback, SAFE_FALLBACK, SERVICE_UNAVAILABLE_FALLBACK, SERVICE_CONFIG_FALLBACK, RULES };
