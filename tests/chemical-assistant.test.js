"use strict";
const assert = require("node:assert/strict");
const chemistry = require("../modules/chemical-assistant");
const links = require("../core/links");

assert.equal(chemistry.isChemicalQuestion("إزاي أعالج مشكلة قلة لزوجة الصابون السائل؟"), true);
assert.equal(chemistry.isChemicalQuestion("عايز تركيبة صابون سائل اقتصادية"), true);
assert.equal(chemistry.isChemicalQuestion("ما طريقة تصنيع معطر أرضيات؟"), true);
assert.equal(chemistry.isChemicalQuestion("لو ريحة الداوني غيرت اعمل إيه"), true);
assert.equal(chemistry.isChemicalQuestion("حد عنده تركيبة كلوركس ألوان 60 لتر تكون شعبي"), true);
assert.equal(chemistry.isChemicalQuestion("فيديو تعليمي من الالف للياء لطريقة تنفيذ تركيبة جيل شعر"), false);
assert.equal(chemistry.isChemicalQuestion("اوكسي سائل غسيل اطباق ب 103 ج عليه تخفيض 13 ج"), false);
assert.equal(chemistry.isChemicalQuestion("اوكسي جيل دا فيه منه توصيل؟"), false);
assert.equal(chemistry.isChemicalQuestion("فلفيتا معطر ملابس 3 لتر بكام"), false);
assert.equal(chemistry.isChemicalQuestion("أسعار المواد الخام عمالة تزيد و بترفع تكاليف الصابون و المنظفات في الشركات"), false);

assert.equal(chemistry.isChemicalQuestion("سعر مسحوق بيرل 25 جنيه"), false);
assert.equal(chemistry.isChemicalQuestion("الصابون السائل بكام؟"), false);
assert.equal(chemistry.isChemicalQuestion("متوفر عندك كلور؟"), false);
assert.equal(chemistry.isChemicalQuestion("مسحوق أريال وصل كام النهارده؟"), false);
assert.equal(chemistry.isChemicalQuestion("المنظفات أسعارها زادت"), false);
assert.equal(chemistry.isChemicalQuestion("/chemical"), false);
assert.match(chemistry.buildPrompt("عايز تركيبة صابون"), /تركيبة شعبية اقتصادية/);
assert.match(chemistry.buildPrompt("عايز تركيبة صابون"), /تركيبة أعلى جودة/);
assert.match(chemistry.buildPrompt("عايز تركيبة صابون"), /TDS\/SDS/);
assert.match(chemistry.buildPrompt("عايز تركيبة صابون"), /لا تعتمد على منشورات التواصل الاجتماعي/);
assert.match(chemistry.buildPrompt("عايز تركيبة صابون"), /unknown-mixture/);
assert.match(chemistry.buildPrompt("عايز تركيبة صابون"), /لا تطلب من المستخدم تحويلها إلى أسماء علمية/);
assert.match(chemistry.buildPrompt("عايز تركيبة صابون"), /تكسابون أو N70 غالبًا SLES/);
assert.match(chemistry.buildPrompt("عايز تركيبة صابون"), /لا تطلب إعادة كتابة الخامات/);
const followUp = chemistry.buildConversationInput({
  text: "عندي تكسابون وسلفونيك وملح وكمبرلان",
  reply_to_message: {
    from: { is_bot: true },
    text: "🧪 المساعد الكيميائي\\nاذكر الخامات المتوفرة",
    reply_to_message: { from: { is_bot: false }, text: "عايز تركيبة صابون سائل بجودة عالية" }
  }
});
assert.match(followUp, /تركيبة صابون سائل/);
assert.match(followUp, /تكسابون وسلفونيك وملح وكمبرلان/);
assert.equal(chemistry.isChemicalQuestion(followUp), true);
assert.match(chemistry.buildPrompt("عايز تركيبة صابون"), /bleach-acid-warning/);
assert.ok(chemistry.safetyGate("هل أخلط الكلور مع حمض الفلاش؟"));
assert.ok(chemistry.safetyGate("خلط الكلور مع الأمونيا"));
assert.ok(chemistry.safetyGate("هل ينفع أخلط كلوركس مع روح الملح؟"));
assert.ok(chemistry.safetyGate("خلط ماء جافيل مع الخل"));
assert.ok(chemistry.safetyGate("هل أخلط المبيض مع النشادر؟"));
assert.equal(chemistry.safetyGate("كيف أقيس pH منظف الأطباق؟"), null);
assert.match(chemistry.safetyGate("كلور مع فلاش"), /لا تخلط/);

const built = links.buildChemicalLinks("تركيبة صابون سائل");
assert.match(links.renderChemicalLinks(built), /<a href=/);
assert.match(links.renderChemicalLinks(built), /قناة التركيبات المحفوظة/);
assert.equal(links.escapeHtml("<b>نص & تجربة</b>"), "&lt;b&gt;نص &amp; تجربة&lt;/b&gt;");
console.log("chemical assistant routing, safety, and links tests: OK");

assert.match(chemistry.getProviderFallback(new Error("AI HTTP 503: overloaded")), /مشغولة أو غير متاحة مؤقتًا/);
assert.match(chemistry.getProviderFallback(new Error("AI HTTP 429: quota exceeded")), /مشغولة أو غير متاحة مؤقتًا/);
assert.match(chemistry.getProviderFallback(new Error("AI HTTP 401: invalid_api_key")), /عطل مؤقت في إعداد الاتصال/);
assert.match(chemistry.getProviderFallback(new Error("AI HTTP 400: invalid request")), /تعذر إعداد إجابة فنية موثوقة/);

(async () => {
  const validQuestion = "عايز تركيبة صابون سائل اقتصادية";
  const serviceFailureAnswer = await chemistry.answer({
    async generate() { throw new Error("AI HTTP 503: Google unavailable"); }
  }, validQuestion);
  assert.match(serviceFailureAnswer, /مشغولة أو غير متاحة مؤقتًا/);
  assert.match(serviceFailureAnswer, /لم يتم رفض سؤالك/);

  let fallbackCalls = 0;
  const recoveredByOpenAIFallback = await chemistry.answer({
    async generate(_prompt, options) {
      assert.equal(options.googleSearch, true, "Gemini chemical requests should use Google Search grounding");
      assert.equal(options.requestBudgetMs, 15000, "primary Gemini work should leave time for fallback");
      throw new Error("AI HTTP 503: Google unavailable");
    }
  }, validQuestion, null, {
    async generate(_prompt, options) {
      fallbackCalls++;
      assert.equal(options.webSearch, false, "OpenAI rescue must not require web search");
      assert.equal(options.model, undefined, "fallback should use the already configured OPENAI_MODEL");
      assert.equal(options.timeoutMs, 14000);
      return { text: "إجابة فنية عملية مباشرة", provider: "openai" };
    }
  });
  assert.equal(fallbackCalls, 1);
  assert.match(recoveredByOpenAIFallback, /تقنيات OpenAI/);
  assert.match(recoveredByOpenAIFallback, /إجابة فنية عملية مباشرة/);

  const permanentFailureAnswer = await chemistry.answer({
    async generate() { throw new Error("AI HTTP 400: invalid request"); }
  }, validQuestion);
  assert.match(permanentFailureAnswer, /تعذر إعداد إجابة فنية موثوقة/);
  assert.doesNotMatch(permanentFailureAnswer, /قبل معرفة الأسماء والتركيزات/);

  const emptyAnswer = await chemistry.answer({
    async generate() { return { text: "   ", provider: "gemini" }; }
  }, validQuestion);
  assert.match(emptyAnswer, /تعذر إعداد إجابة فنية موثوقة/);

  const sqlCalls = [];
  const pool = { async query(sql, params) {
    sqlCalls.push({ sql, params });
    if (sql.includes("SELECT context_text")) {
      return { rows: [{ context_text: "عايز تركيبة صابون سائل بجودة عالية" }] };
    }
    return { rows: [], rowCount: 1 };
  } };
  const realTelegramReply = {
    chat: { id: -100123 },
    text: "عندي تكسابون وسلفونيك وملح وكمبرلان",
    reply_to_message: {
      message_id: 456,
      from: { is_bot: true },
      text: "🧪 المساعد الكيميائي\\nاذكر الخامات المتوفرة"
      // Telegram does not reliably include a nested reply_to_message here.
    }
  };
  const resolved = await chemistry.resolveConversationInput(pool, realTelegramReply);
  assert.match(resolved, /تركيبة صابون سائل بجودة عالية/);
  assert.match(resolved, /تكسابون وسلفونيك وملح وكمبرلان/);
  assert.equal(chemistry.isChemicalQuestion(resolved), true);
  await chemistry.ensureConversationContextSchema(pool);
  await chemistry.saveConversationContext(pool, {
    chatId: -100123, assistantMessageId: 789,
    contextText: resolved
  });
  assert.ok(sqlCalls.some(call => call.sql.includes("CREATE TABLE IF NOT EXISTS chemical_conversation_contexts")));
  assert.ok(sqlCalls.some(call => call.sql.includes("INSERT INTO chemical_conversation_contexts")));
  assert.ok(sqlCalls.some(call => call.sql.includes("DELETE FROM chemical_conversation_contexts")));
  console.log("chemical assistant durable Telegram reply-context tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
