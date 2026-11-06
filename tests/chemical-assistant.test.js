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
assert.equal(chemistry.isChemicalQuestion("فلفيتا معطر ملابس 3 لتر بكام"), false);
assert.equal(chemistry.isChemicalQuestion("/chemical"), false);

const prompt = chemistry.buildPrompt("عايز تركيبة جيل غسيل ملابس");
assert.match(prompt, /لا أن تكتفي بالنصائح العامة|لا أن تكتفي بالنصائح/);
assert.match(prompt, /لا تتهرب بطلب قائمة الخامات/);
assert.match(prompt, /لا تطلب منه سرد الخامات المتاحة/);
assert.match(prompt, /تكسابون أو تكسابون N70/);
assert.match(prompt, /سلفونيك/);
assert.match(prompt, /صودا كاوية/);
assert.match(prompt, /بيتائين/);
assert.match(prompt, /كمبرلان/);
assert.match(prompt, /تيلوز/);
assert.match(prompt, /اسم الخامة بالسوق المصري أولًا/);
assert.match(prompt, /أساس 100 كجم/);
assert.match(prompt, /مجموع الكميات يساوي 100 كجم/);
assert.match(prompt, /TDS\/SDS/);
assert.match(prompt, /unknown-mixture/);
assert.match(prompt, /bleach-acid-warning/);
assert.match(prompt, /لا تخلط الكلور\/المبيض مع الأحماض أو الأمونيا/);
assert.doesNotMatch(prompt, /ابدأ بفهم هدف المنتج والخامات المتاحة/);

const followUp = chemistry.buildConversationInput({
  text: "عندي تكسابون وسلفونيك وملح وكمبرلان",
  reply_to_message: {
    from: { is_bot: true },
    text: "🧪 المساعد الكيميائي",
    reply_to_message: { from: { is_bot: false }, text: "عايز تركيبة صابون سائل بجودة عالية" }
  }
});
assert.match(followUp, /تركيبة صابون سائل/);
assert.match(followUp, /تكسابون وسلفونيك وملح وكمبرلان/);
assert.equal(chemistry.isChemicalQuestion(followUp), true);

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

assert.match(chemistry.getProviderFallback(new Error("AI HTTP 503: overloaded")), /مشغولة أو غير متاحة مؤقتًا/);
assert.match(chemistry.getProviderFallback(new Error("AI HTTP 429: quota exceeded")), /مشغولة أو غير متاحة مؤقتًا/);
assert.match(chemistry.getProviderFallback(new Error("AI HTTP 401: invalid_api_key")), /عطل مؤقت في إعداد الاتصال/);
assert.match(chemistry.getProviderFallback(new Error("AI HTTP 400: invalid request")), /تعذر إعداد إجابة فنية موثوقة/);

(async () => {
  const validQuestion = "عايز تركيبة صابون سائل اقتصادية";
  const providerCalls = [];
  const answer = await chemistry.answer({
    async generate(promptText, options) {
      providerCalls.push({ promptText, options });
      assert.match(promptText, /أسماء الخامات المتداولة في سوق المنظفات المصري/);
      assert.equal(options.webSearch, false, "the primary formulation path should not wait for optional web search");
      assert.equal(options.timeoutMs, 3500, "each configured provider key has a bounded timeout");
      assert.equal(options.requestBudgetMs, 14000, "OpenAI key rotation and Groq rescue share one bounded request budget");
      return { text: "تركيبة مبدئية عملية", provider: "openai" };
    }
  }, validQuestion);
  assert.equal(providerCalls.length, 1);
  assert.match(answer, /تقنيات OpenAI/);
  assert.match(answer, /تركيبة مبدئية عملية/);

  let reportedError = null;
  const unavailable = await chemistry.answer({
    async generate() { throw new Error("AI HTTP 503: OpenAI unavailable"); }
  }, validQuestion, error => { reportedError = error; });
  assert.match(unavailable, /مشغولة أو غير متاحة مؤقتًا/);
  assert.match(unavailable, /لم يتم رفض سؤالك/);
  assert.match(reportedError.message, /503/);

  const missingConfig = await chemistry.answer(null, validQuestion);
  assert.match(missingConfig, /عطل مؤقت في إعداد الاتصال/);

  const emptyAnswer = await chemistry.answer({
    async generate() { return { text: "   ", provider: "openai" }; }
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
  const telegramReply = {
    chat: { id: -100123 },
    text: "عندي تكسابون وسلفونيك وملح وكمبرلان",
    reply_to_message: {
      message_id: 456,
      from: { is_bot: true },
      text: "🧪 المساعد الكيميائي"
    }
  };
  const resolved = await chemistry.resolveConversationInput(pool, telegramReply);
  assert.match(resolved, /تركيبة صابون سائل بجودة عالية/);
  assert.match(resolved, /تكسابون وسلفونيك وملح وكمبرلان/);
  await chemistry.ensureConversationContextSchema(pool);
  await chemistry.saveConversationContext(pool, {
    chatId: -100123, assistantMessageId: 789, contextText: resolved
  });
  assert.ok(sqlCalls.some(call => call.sql.includes("CREATE TABLE IF NOT EXISTS chemical_conversation_contexts")));
  assert.ok(sqlCalls.some(call => call.sql.includes("INSERT INTO chemical_conversation_contexts")));
  assert.ok(sqlCalls.some(call => call.sql.includes("DELETE FROM chemical_conversation_contexts")));
  console.log("chemical assistant market-language, manual-answer, safety, and context tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
