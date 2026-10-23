"use strict";
const assert = require("node:assert/strict");
const chemistry = require("../modules/chemical-assistant");
const links = require("../core/links");

assert.equal(chemistry.isChemicalQuestion("إزاي أعالج مشكلة قلة لزوجة الصابون السائل؟"), true);
assert.equal(chemistry.isChemicalQuestion("سعر مسحوق بيرل 25 جنيه"), false);
assert.equal(chemistry.isChemicalQuestion("/chemical"), false);
assert.match(chemistry.buildPrompt("عايز تركيبة صابون"), /تركيبة شعبية اقتصادية/);
assert.match(chemistry.buildPrompt("عايز تركيبة صابون"), /تركيبة أعلى جودة/);
assert.ok(chemistry.safetyGate("هل أخلط الكلور مع حمض الفلاش؟"));
assert.ok(chemistry.safetyGate("خلط الكلور مع الأمونيا"));
const built = links.buildChemicalLinks("تركيبة صابون سائل");
assert.match(links.renderChemicalLinks(built), /<a href=/);
assert.match(links.renderChemicalLinks(built), /قناة التركيبات المحفوظة/);
assert.equal(links.escapeHtml("<b>نص & تجربة</b>"), "&lt;b&gt;نص &amp; تجربة&lt;/b&gt;");
console.log("chemical assistant routing, safety, and links tests: OK");
