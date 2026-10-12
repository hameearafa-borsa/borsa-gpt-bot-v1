"use strict";

const { encodeQuery } = require("../core/links");

function buildWeatherSearch(city = "القاهرة") {
  const q = `طقس ${String(city || "القاهرة").trim().slice(0, 80)}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

async function getWeatherSummary(ai, city = "القاهرة") {
  const url = buildWeatherSearch(city);
  if (!ai?.generate) return { ok: false, city, searchUrl: url, message: "لا توجد خدمة طقس مباشرة مضبوطة حاليًا؛ هذا رابط بحث فقط وليس توقعًا مؤكدًا." };
  try {
    const result = await ai.generate(`أخبر المستخدم أنك لا تملك اتصالًا مباشرًا ببيانات الطقس الحية. لا تخترع درجة حرارة أو حالة طقس. المدينة: ${city}.`, { temperature: 0 });
    return { ok: true, city, searchUrl: url, message: String(result?.text || "لا تتوفر بيانات طقس حية الآن.") };
  } catch (error) { return { ok: false, city, searchUrl: url, message: "تعذر الحصول على ملخص الآن، ولم يتم اختراع بيانات الطقس.", error: error.message }; }
}
module.exports = { buildWeatherSearch, getWeatherSummary };
