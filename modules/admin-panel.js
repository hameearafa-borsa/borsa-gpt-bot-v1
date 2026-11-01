"use strict";

// Service panel only. Moderation and member-protection controls belong to GroupHelpBot.
const ROWS = [
  [{ text: "🧪 المساعد الكيميائي", callback_data: "panel:chemical" }, { text: "💰 مرصد الأسعار", callback_data: "panel:prices" }],
  [{ text: "📋 قوائم الشركات", callback_data: "panel:lists" }, { text: "🏪 قاعدة بيانات التجار", callback_data: "panel:merchants" }],
  [{ text: "🛍️ العروض والنشرات", callback_data: "panel:deals" }, { text: "🌦️ الطقس", callback_data: "panel:weather" }],
  [{ text: "📊 التقارير", callback_data: "panel:reports" }, { text: "🩺 صحة النظام", callback_data: "panel:health" }],
  [{ text: "📄 تقارير التشخيص", callback_data: "panel:diagnostics" }],
  [{ text: "⚙️ إعدادات الخدمات", callback_data: "panel:settings" }, { text: "👥 المجموعات المعتمدة", callback_data: "panel:groups" }]
];
function privatePanelKeyboard() {
  return { inline_keyboard: ROWS.map(row => row.map(button => ({ ...button }))) };
}
function panelText(version, providers = []) {
  return \`📊 لوحة خدمات بورصة المنظفات — \${version}\\n\\nاختر الخدمة التي تريد مراجعتها. اللوحة مخصصة لمالك البوت، ولا تتضمن أدوات حماية أو إدارة أعضاء المجموعة.\\nمحركات الذكاء المضبوطة: \${providers.length ? providers.join("، ") : "لا يوجد مزود مضبوط"}\\n\\nالحفظ التلقائي لبيانات التجار ومرصد الأسعار يعملان في الخلفية عند تحقق شروط التسجيل.\\nمدعوم بتقنيات ChatGPT\`;
}
function settingsText(scope, chatId, settings) {
  const title = scope === "global" ? "⚙️ إعدادات الخدمات العامة" : "⚙️ إعدادات المجموعة";
  const rows = settings.map(item => \`\${item.enabled ? "🟢" : "🔴"} \${item.label}: \${item.enabled ? "مفعلة" : "متوقفة"}\`);
  return \`\${title}\${chatId ? \`\\nالمجموعة: \${chatId}\` : ""}\\n\\n\${rows.join("\\n")}\\n\\nيُحفظ التغيير فورًا في قاعدة البيانات. الإيقاف العام يتقدم على إعداد المجموعة.\`;
}
function settingsKeyboard(settings, scope, chatId = 0) {
  const buttons = settings.map(item => ({
    text: \`\${item.enabled ? "🟢" : "🔴"} \${item.label}\`,
    callback_data: scope === "global" ? \`panel:toggle:\${item.key}\` : \`panel:group-toggle:\${chatId}:\${item.key}\`
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "⬅️ رجوع", callback_data: scope === "global" ? "panel:home" : "group-settings:refresh" }]);
  return { inline_keyboard: rows };
}
function groupsKeyboard(groups) {
  const rows = groups.map(group => [{
    text: \`👥 \${group.chat_id}\`,
    callback_data: \`panel:group:\${group.chat_id}\`
  }]);
  rows.push([{ text: "⬅️ القائمة الرئيسية", callback_data: "panel:home" }]);
  return { inline_keyboard: rows };
}
function actionKeyboard() {
  return { inline_keyboard: [[{ text: "⬅️ القائمة الرئيسية", callback_data: "panel:home" }]] };
}
module.exports = { privatePanelKeyboard, panelText, actionKeyboard, settingsText, settingsKeyboard, groupsKeyboard };
