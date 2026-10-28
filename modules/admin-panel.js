"use strict";

// Service panel only. Moderation and member-protection controls belong to GroupHelpBot.
const ROWS = [
  [{ text: "🧪 المساعد الكيميائي", callback_data: "panel:chemical" }, { text: "💰 مرصد الأسعار", callback_data: "panel:prices" }],
  [{ text: "📋 قوائم الشركات", callback_data: "panel:lists" }, { text: "🏪 قاعدة بيانات التجار", callback_data: "panel:merchants" }],
  [{ text: "🛍️ العروض والنشرات", callback_data: "panel:deals" }, { text: "🌦️ الطقس", callback_data: "panel:weather" }],
  [{ text: "📊 التقارير", callback_data: "panel:reports" }, { text: "🩺 صحة النظام", callback_data: "panel:health" }],
  [{ text: "📄 تقارير التشخيص", callback_data: "panel:diagnostics" }]
];

function privatePanelKeyboard() {
  return { inline_keyboard: ROWS.map(row => row.map(button => ({ ...button }))) };
}
function panelText(version, providers = []) {
  return `📊 لوحة خدمات بورصة المنظفات — ${version}\n\nاختر الخدمة التي تريد مراجعتها. اللوحة مخصصة لمالك البوت، ولا تتضمن أدوات حماية أو إدارة أعضاء المجموعة.\nمحركات الذكاء المضبوطة: ${providers.length ? providers.join("، ") : "لا يوجد مزود مضبوط"}\n\nالحفظ التلقائي لبيانات التجار ومرصد الأسعار يعملان في الخلفية عند تحقق شروط التسجيل.\nمدعوم بتقنيات ChatGPT`;
}
function actionKeyboard() {
  return { inline_keyboard: [[{ text: "⬅️ القائمة الرئيسية", callback_data: "panel:home" }]] };
}
module.exports = { privatePanelKeyboard, panelText, actionKeyboard };
