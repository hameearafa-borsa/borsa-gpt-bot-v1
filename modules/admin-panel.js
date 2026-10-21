"use strict";

// Private control panel only. Every callback must still be authorized server-side.
const ROWS = [
  [{ text: "🧪 المساعد الكيميائي", callback_data: "panel:chemical" }, { text: "💰 رصد الأسعار", callback_data: "panel:prices" }],
  [{ text: "📋 قوائم الشركات", callback_data: "panel:lists" }, { text: "🏪 بيانات التجار", callback_data: "panel:merchants" }],
  [{ text: "🛍️ العروض", callback_data: "panel:deals" }, { text: "📊 التقارير", callback_data: "panel:reports" }],
  [{ text: "🛡️ الحماية والإنذارات", callback_data: "panel:protection" }, { text: "👥 الأعضاء الخاملون", callback_data: "panel:inactive" }],
  [{ text: "🩺 تشخيص النظام", callback_data: "panel:health" }, { text: "🌐 اختبار مصدر العروض", callback_data: "panel:scraper_test" }],
  [{ text: "📄 آخر تقارير الأخطاء", callback_data: "panel:diagnostics" }]
];

function privatePanelKeyboard() { return { inline_keyboard: ROWS.map(row => row.map(button => ({ ...button }))) }; }
function panelText(version, providers = []) {
  return `🛡️ لوحة Borsa GBT Bot V1 Mona Lisa — ${version}\n\nاختر الخدمة. هذه اللوحة خاصة ولا تُرسل أزرارها إلى المجموعة.\nمحركات الذكاء المضبوطة: ${providers.length ? providers.join("، ") : "لا يوجد مزود مضبوط"}\n\n${"مدعوم بتقنيات ChatGPT"}`;
}
function actionKeyboard() { return { inline_keyboard: [[{ text: "⬅️ القائمة الرئيسية", callback_data: "panel:home" }]] }; }
module.exports = { privatePanelKeyboard, panelText, actionKeyboard };
