"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { normalizeArabic } = require("../core/normalization");
const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/chemical-rules.json"), "utf8")).rules;
const KNOWLEDGE = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/chemical-knowledge.json"), "utf8"));
const SAFE_FALLBACK = "أحتاج اسم المادة أو نوع المنتج (سائل جلي، مسحوق، منعم، مبيض) والتركيز المكتوب على الخامة حتى أجيب بنطاق مرجعي واضح بدل التخمين.";

function hasBleach(text) { return /(كلور|مبيض|هيبوكلوريت|كلوركس)/.test(text) && !/مبيض ضوئي|اوبتيكال|optical/.test(text); }
function hasAcid(text) { return /(حمض|حامض|فلاش|منظف حمضي|ستريك)/.test(text) || /(?:^|\s)ال?خل(?:\s|$)/.test(text); }
function hasAmmonia(text) { return /(امونيا|نشادر)/.test(text); }

function safetyGate(question) {
  const s = normalizeArabic(question);
  if (hasBleach(s) && hasAcid(s)) return "⚠️ تحذير سلامة: لا تخلط الكلور أو الهيبوكلوريت مع حمض أو خل أو سلفونيك أو منظف حمضي. التفاعل قد يطلق غاز كلور. لا أستطيع إعطاء خطوات هذا الخلط. افصل المنتجين في عبوتين واستخدم كلًا منهما وحده مع شطف السطح بينهما.";
  if (hasBleach(s) && hasAmmonia(s)) return "⚠️ تحذير سلامة: لا تخلط الكلور أو المبيض مع أمونيا أو نشادر أو منعم كاتيوني. قد تتولد كلورامينات مهيجة. لا خطوات خلط لهذه الحالة.";
  return null;
}

function findMaterials(question) {
  const s = normalizeArabic(question);
  return KNOWLEDGE.materials.filter((item) => (item.aliases || []).some((alias) => alias && s.includes(normalizeArabic(alias))));
}

function findFrameworks(question) {
  const s = normalizeArabic(question);
  return KNOWLEDGE.frameworks.filter((item) => (item.aliases || []).some((alias) => alias && s.includes(normalizeArabic(alias))));
}

function looksLikeChemicalQuestion(text) {
  const s = normalizeArabic(text);
  if (!s) return false;
  const asks = /(وظيفه|تركيبه|تركيب|نسبه|نسب|تركيز|اشرح|ما هو|ما هي|كيف|هل |صلاح|توافق|بديل|ph|درجه|صيغة|صيغه|framework)/.test(s);
  const priced = /\d+(?:[.,]\d+)?\s*(?:جنيه|ج)(?=\s|$)/.test(s);
  const known = findMaterials(s).length > 0 || findFrameworks(s).length > 0;
  if (priced && !asks) return false;
  return (asks && (known || /(كلور|حمض|قلوي|ماده|خلط|منظف)/.test(s))) || (known && /(عايز|محتاج|ابغى|ابغي|ممكن تركيبه|اعمل)/.test(s));
}

function renderLocal(question) {
  const materials = findMaterials(question);
  const frameworks = findFrameworks(question);
  if (!materials.length && !frameworks.length) return "";
  const lines = [
    "🧪 تقرير المساعد الكيميائي — بورصة المنظفات",
    KNOWLEDGE.disclaimer,
    "هذا المرجع المحلي هو النص المعتمد. أي نسبة لا تظهر هنا لا تُستخدم في الإنتاج.",
    "",
  ];
  if (frameworks.length) {
    lines.push("الخلاصة:");
    for (const item of frameworks) lines.push(`• ${item.title}: ${item.targets}`);
    lines.push("");
  } else if (materials[0]) {
    lines.push(`الخلاصة: ${materials[0].role}`);
    lines.push("");
  }
  for (const item of frameworks) {
    lines.push(`📘 ${item.title}`);
    lines.push("الإطار المرجعي للتجربة المعملية (1 كجم أو 100 جزء):");
    for (const line of item.lines) lines.push(`• ${line}`);
    lines.push("ترتيب العمل الوصفي: الماء أولًا، ثم المادة الفعالة، ثم التعادل أو البناء، ثم المساعدات، والعطر والإنزيم في النهاية بعد انخفاض الحرارة.");
    for (const warning of item.warnings || []) lines.push(`⚠️ ${warning}`);
    lines.push("");
  }
  for (const item of materials) {
    lines.push(`⚗️ ${item.name}`);
    lines.push(`الوظيفة: ${item.role}`);
    lines.push(`النطاق المرجعي: ${item.range}`);
    lines.push(`التداول: ${item.handling}`);
    if (item.incompatible?.length) lines.push(`لا يُجمع مع: ${item.incompatible.join("، ")}`);
    lines.push("");
  }
  lines.push("قبل أي خلط أكبر من عينة:");
  lines.push("• اكتب تركيز الخامة كما هو على العبوة، مثل SLES 70% أو LABSA 96%، واحسب المادة الفعالة لا وزن العجينة.");
  lines.push("• قس pH ودرجة الحرارة بعد التعادل، ثم أعد القياس بعد 24 ساعة.");
  lines.push("• جرّب على 100–200 جم أولًا. لا تنقل النسبة إلى خزان إنتاج قبل ثبات اللزوجة والرائحة والمظهر.");
  lines.push("• إذا كان السؤال عن خلط الكلور مع حمض أو أمونيا فالجواب رفض، بلا خطوات.");
  return lines.join("\n").trim();
}

function numbersIn(text) {
  const western = String(text || "")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
  return new Set([...western.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => match[0].replace(",", ".")));
}

function faithfulAddendum(extra, local) {
  const clean = String(extra || "").trim();
  if (clean.length < 80) return false;
  const allowed = numbersIn(local);
  for (const value of numbersIn(clean)) if (!allowed.has(value)) return false;
  const normalized = normalizeArabic(clean);
  if (/(كلور|هيبوكلوريت)/.test(normalized) && /(حمض|خل|سلفونيك|امونيا)/.test(normalized)) return false;
  return true;
}

async function answer(ai, question) {
  const gate = safetyGate(question);
  if (gate) return gate.slice(0, 3900);
  const local = renderLocal(question);
  if (!local) return SAFE_FALLBACK.slice(0, 3900);
  const base = local.slice(0, 3600);
  if (!ai || typeof ai.generate !== "function") return base.slice(0, 3900);
  try {
    const result = await ai.generate(buildPrompt(question, local), { maxOutputTokens: 900, reasoningEffort: "low" });
    const extra = String(result?.text || "").trim();
    if (!faithfulAddendum(extra, local)) return base.slice(0, 3900);
    const clipped = extra.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 6).join("\n").slice(0, 600);
    return `${base}\n\n📝 إضافة ضمن المرجع المحلي فقط:\n${clipped}`.slice(0, 3900);
  } catch {
    return base.slice(0, 3900);
  }
}
function buildPrompt(question, localReference = "") {
  const rules = RULES.map((rule) => `- ${rule.trigger}: ${rule.action}`).join("\n");
  return [
    "أنت كيميائي تطبيقات منظفات تخاطب تجار بورصة المنظفات بالعربية.",
    "لا تضف أي نسبة غير موجودة حرفيًا في المرجع المحلي.",
    "لا تعطِ خطوات خلط الكلور مع حمض أو أمونيا أو سلفونيك.",
    "إن لم يكن لديك ما تضيفه داخل هذه الحدود فقل: المرجع كافٍ.",
    "قواعد السلامة:",
    rules,
    localReference ? `المرجع المحلي المعتمد:\n${localReference}` : "لا يوجد مرجع محلي مطابق.",
    `السؤال: ${String(question || "").slice(0, 5000)}`
  ].join("\n");
}

module.exports = {
  answer, buildPrompt, safetyGate, SAFE_FALLBACK, RULES, hasAcid, hasBleach,
  findMaterials, findFrameworks, looksLikeChemicalQuestion, renderLocal, faithfulAddendum,
};
