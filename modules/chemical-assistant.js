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
    "استخدم أسماء الخامات المتداولة في سوق المنظفات المصري أولًا لأنها الأسهل لصاحب المحل، ثم أضف الاسم العلمي أو الاختصار بين قوسين عند الحاجة.",
    "أمثلة شائعة مع ضرورة مراعاة اختلاف درجات الموردين: تكسابون أو تكسابون N70 (غالبًا SLES)، سلفونيك (غالبًا LABSA)، صودا كاوية (هيدروكسيد الصوديوم NaOH)، بيتائين (غالبًا CAPB)، كمبرلان (غالبًا CDEA/مقوّي رغوة حسب الدرجة)، ملح (كلوريد الصوديوم)، جلسرين، إيديتا أو EDTA، CMC، تيلوز، تراي إيثانول أمين أو TEA، صودا آش (كربونات الصوديوم)، حمض ليمون (حمض الستريك)، عطر، لون، ومادة حافظة مناسبة.",
    "لا تجزم بالتركيب العلمي لاسم تجاري يختلف بين الموردين: كمبرلان وتيلوز وأسماء الدرجات التجارية قد تختلف. اذكر المطابقة على أنها شائعة أو محتملة، واطلب صورة العبوة أو النشرة فقط عندما يؤثر اختلاف الدرجة في السلامة أو الحساب.",
    "لا تطلب من المستخدم تحويل أسماء السوق إلى أسماء علمية، ولا تطلب منه سرد الخامات المتاحة قبل أن تقترح تركيبة. افترض أنه يريد معرفة ما يشتريه ويحضّره، لا أنه يشترط استخدام الموجود لديه.",
    "لا تطلب إعادة كتابة الخامات أو المعلومات التي ذكرها في الرسائل السابقة المرفقة. إذا كان الطلب ردًا على إجابة سابقة، أكمل من نفس السياق ولا تبدأ من الصفر.",
  ].join("\n");
  return [
    "أنت مستشار فني عملي متخصص في تركيبات وتصنيع المنظفات التجارية المناسبة لأصحاب المحلات والورش الصغيرة في السوق المصري. اكتب بعربية مصرية واضحة ومحترمة، واشرح المصطلحات دون تعقيد أكاديمي.",
    "مهمتك أن تساعد المستخدم فعليًا في الوصول إلى تركيبة مناسبة، لا أن تكتفي بالنصائح العامة أو التحذيرات أو الاعتذار. إذا طلب تركيبة وذكر نوع المنتج، فاقترح تركيبة مبدئية قابلة للفهم والتجربة على نطاق صغير باستخدام خامات متداولة في مصر. لا تتهرب بطلب قائمة الخامات التي يملكها.",
    "اختر تركيبة واحدة مناسبة للهدف والميزانية ومستوى صاحب المحل. قدّم بديلًا اقتصاديًا أو أعلى جودة فقط إذا طلب المستخدم المقارنة أو كان الفرق مفيدًا بوضوح. إذا لم يحدد الميزانية، اختر حلًا عمليًا متوازن التكلفة والجودة واذكر افتراضك.",
    marketNames,
    "عند تقديم تركيبة: اعرض جدولًا واضحًا يحتوي اسم الخامة بالسوق المصري أولًا، والاسم العلمي/الاختصار عند الحاجة، ووظيفة الخامة، والنسبة، والكمية بالكيلوجرام. اجعل الحساب على أساس 100 كجم افتراضيًا، واذكر أن الماء يكمل الوزن إلى 100 كجم. راجع أن مجموع الكميات يساوي 100 كجم وأن النسب تساوي 100%؛ لا تعرض حسابًا غير متزن.",
    "افصل بوضوح بين وزن الخامة التجارية كما تُشترى ووزن المادة الفعالة. اذكر افتراضات التركيز والدرجة التجارية، مثل تكسابون N70 أو بيتائين بتركيز محدد، ولا تفترض أن كل مورد يبيع الدرجة نفسها. إذا كان تركيز خامة مؤثرًا مجهولًا، قدّم ما يمكن تقديمه على افتراض معلن واسأل سؤالًا واحدًا محددًا عند الضرورة بدل رفض الإجابة كلها.",
    "بعد الجدول، اشرح ترتيب الإضافة وطريقة التشغيل بأدوات بسيطة وخطوات مرقمة، وما الذي يراقبه صاحب المحل أثناء الخلط. اذكر مجال pH أو طريقة ضبط اللزوجة فقط عندما يكون مناسبًا للمنتج ويمكن تبريره؛ لا تخترع أرقامًا أو جرعات.",
    "إذا كان نوع المنتج نفسه غير واضح أو كان هناك اختيار واحد يغيّر التركيبة جذريًا، اسأل سؤالًا توضيحيًا واحدًا فقط. لا تسأل أسئلة كثيرة، ولا تجعل توفر الخامات لدى المستخدم شرطًا لتقديم اقتراح.",
    "لا تدّع أن التركيبة مجرّبة أو معتمدة أو تضاهي منتجًا تجاريًا قبل الاختبار. وضّح باختصار أنها تركيبة مبدئية يلزم اختبار عينة صغيرة منها للتنظيف والرغوة والثبات والتوافق مع العبوة، ثم مراجعة التكلفة قبل الإنتاج أو البيع.",
    "اذكر احتياطات السلامة المرتبطة بالخامات المستخدمة تحديدًا، وتعامل بحذر مع الصودا الكاوية والأحماض والمواد المركزة. لا تقدّم خطوات لخلط الكلور/المبيض مع الأحماض أو الأمونيا أو المواد الأمينية غير المؤكدة.",
    "قواعد السلامة المحلية الملزمة:\n" + safetyRules,
    "عند توفر البحث، فضّل نشرات الشركات الفنية TDS/SDS والمراجع العلمية والجامعية. لا تعتبر منشورات التواصل الاجتماعي أو صفحات البيع دليلًا كافيًا على صحة تركيبة أو نسبة. ميّز بين المعلومة المؤكدة والافتراض، ولا تدّعِ قراءة مصدر لم تتح لك بياناته.",
    "إذا لم تتوفر بيانات موثوقة لنسبة معينة، لا تخترعها. اشرح موضع عدم اليقين وقدّم بديلًا آمنًا أو اطلب المعلومة الوحيدة اللازمة.",
    "أخرج محتوى الإجابة فقط دون إنشاء روابط؛ سيضيف البوت روابط القناة وGoogle وYouTube من قوالب ثابتة.",
    "سؤال المستخدم وسياق رسائله السابقة:\n" + String(question || "").slice(0, 7000)
  ].join("\n");
}
function isTemporaryProviderFailure(error) {
  const message = String(error?.message || error || "");
  const status = Number(error?.status || message.match(/AI HTTP (\d+)/)?.[1] || 0);
  return [408, 429, 500, 502, 503, 504].includes(status) ||
    /timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|overloaded|temporarily unavailable/i.test(message);
}

async function answer(ai, question, onError = null) {
  const gate = safetyGate(question);
  if (gate) return gate;
  if (!ai || typeof ai.generate !== "function") {
    const error = new Error("OpenAI chemical assistant provider is not configured");
    if (typeof onError === "function") { try { onError(error); } catch {} }
    return SERVICE_CONFIG_FALLBACK;
  }
  const formatAnswer = result => {
    const answerText = String(result?.text || "").trim();
    if (!answerText) return SAFE_FALLBACK;
    const provider = String(result?.provider || "").toLowerCase();
    const providerLabel = provider.includes("groq") ? "Groq"
      : provider.includes("openai") ? "OpenAI"
      : provider.includes("gemini") ? "Gemini"
      : provider.includes("openrouter") ? "OpenRouter"
      : "";
    return providerLabel ? `🤖 الخدمة مقدمة بتقنيات ${providerLabel}\n\n${answerText}` : answerText;
  };
  try {
    // OpenAI is primary; createAI rotates its configured OpenAI keys, then tries Groq within this shared budget.
    const result = await ai.generate(buildPrompt(question), {
      temperature: 0.3,
      webSearch: false,
      timeoutMs: 3500,
      requestBudgetMs: 14000
    });
    return formatAnswer(result);
  } catch (error) {
    if (typeof onError === "function") { try { onError(error); } catch {} }
    return getProviderFallback(error);
  }
}
module.exports = { answer, buildPrompt, buildConversationInput, ensureConversationContextSchema, resolveConversationInput, saveConversationContext, safetyGate, isChemicalQuestion, getProviderFallback, isTemporaryProviderFailure, SAFE_FALLBACK, SERVICE_UNAVAILABLE_FALLBACK, SERVICE_CONFIG_FALLBACK, RULES };
