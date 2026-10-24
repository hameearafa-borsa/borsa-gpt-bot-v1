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
