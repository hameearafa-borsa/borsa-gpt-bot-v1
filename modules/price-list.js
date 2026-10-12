"use strict";
const { normalizeArabic, toAsciiDigits, parseNumber, parseQuantity } = require("../core/normalization");
const { extractPriceCandidates, commercialMetrics } = require("./price-intelligence");

const PRICE_TOKEN = /(?:^|[\s|:])([0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)?)\s*(?:جنيه|ج|EGP)?(?=\s|\||$)/giu;
const WEIGHT_TOKEN = /([0-9٠-٩۰-۹]+(?:[.,][0-9٠-٩۰-۹]+)?)\s*(كيلو|كجم|ك|kg|جرام|جم|g|لتر|ل|liter|ml|مل)/iu;
const RETAIL_LABEL = /(?:مستهلك|قطاعي|تجزئ|بيع للمستهلك|بيع قطاعي)/iu;
const WHOLESALE_LABEL = /(?:جمله|جملة|سعر الجمله|سعر الجملة)/iu;

function isListLike(text) {
  const s = toAsciiDigits(String(text || ""));
  const lines = s.split(/\r?\n/).filter(Boolean).length;
  const priceHits = (s.match(/[0-9]+(?:[.,][0-9]+)?\s*(?:ج|جنيه|EGP)(?=\s|\||$)/gi) || []).length;
  return lines >= 5 && (priceHits >= 3 || (s.match(/\|/g) || []).length >= 3);
}
function buildListPrompt(text) {
  return [
    "استخرج قائمة أسعار تجارية للمنظفات ومنتجات الورق والعناية الشخصية.",
    "أعد JSON فقط بالشكل: {\"company\":null,\"items\":[{\"product\":null,\"variant\":null,\"weight_g\":null,\"volume_ml\":null,\"pack_count\":null,\"package_sale_price\":null,\"wholesale_carton_price\":null,\"consumer_price\":null,\"list_price\":null,\"decision\":\"accepted|review|skipped\"}]}.",
    "السعر الأول بعد الوزن هو سعر العبوة إذا كان واضحًا. قيمة جملة المنفصلة تحفظ في wholesale_carton_price ولا تستبدل سعر العبوة. قيمة مستهلك تحفظ في consumer_price.",
    "لا تستنتج عدد قطع الكرتونة من قسمة الأسعار؛ سجّل pack_count فقط إذا ذُكر صراحة مثل 4ق.",
    "أسماء الأقسام مثل أوتوماتيك وأوزان وشكاير والعبوات الصغيرة تصف النوع ولا تستبدل اسم الشركة/العلامة.",
    "كلمة شكارة هي نوع العبوة وليست اسم منتج. لا تعتبر الأرقام وحدها اسم منتج.",
    "إذا كان اسم الشركة/العلامة غير موجود في السطر، استخدم company + section + weight كتعريف مؤقت، واجعل القرار review إذا لم تكن الهوية واضحة.",
    "إذا كان السطر غير واضح، decision=skipped. ممنوع اختراع بيانات.",
    String(text || "").slice(0, 18000)
  ].join("\n");
}
function parseAIJson(text) {
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  const start = clean.search(/\{/); const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI list JSON missing");
  const obj = JSON.parse(clean.slice(start, end + 1));
  if (!obj || !Array.isArray(obj.items)) throw new Error("AI list JSON invalid");
  return obj;
}
function getPriceTokens(line) {
  const s = toAsciiDigits(line).replace(/٫/g, ".");
  return [...s.matchAll(PRICE_TOKEN)].map(m => {
    const end = m.index + m[0].length;
    const tail = s.slice(end);
    const isQuantity = /^\s*(?:كيلو|كجم|ك(?=\s|:)|kg|جرام|جم|g|لتر|ل(?=\s|:)|ml|مل)/i.test(tail);
    return { value: parseNumber(m[1]), index: m.index, token: m[0].trim(), isQuantity };
  }).filter(x => !x.isQuantity && x.value != null && x.value > 0 && x.value < 100000);
}
function cleanProductName(line) {
  let source = String(line || "").split("|")[0];
  // In table-like lines, text after the colon is a price column, not product identity.
  if (source.includes(":")) source = source.slice(0, source.indexOf(":"));
  return toAsciiDigits(source)
    .replace(/^[\s•*._-]+/, "")
    .replace(/\d+(?:[.,]\d+)?\s*(?:كيلو|كجم|ك|kg|جرام|جم|g|لتر|ل|liter|ml|مل)/giu, " ")
    .replace(/\d+(?:[.,]\d+)?\s*(?:جنيه|ج|EGP)/giu, " ")
    .replace(/\b\d+\s*(?:ق|قط|قطعه|قطعة)/giu, " ")
    .replace(/\s+/g, " ").trim();
}
function deterministicList(text) {
  const lines = String(text || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  let company = null, section = null;
  const out = [];
  for (const line of lines) {
    if (/^[-_=.*.]{3,}$/.test(line)) continue;
    const normalized = normalizeArabic(line);
    if (!/(?:\d+(?:[.,]\d+)?\s*(?:جنيه|ج|egp)|\|)/i.test(toAsciiDigits(line))) {
      if (/اوتوماتيك|automatic/i.test(normalized)) { section = "مسحوق أوتوماتيك"; continue; }
      if (/اوزان|شكاير|شكاره/i.test(normalized)) { section = "أوزان وشكاير"; continue; }
      if (/عبوات صغيره|العبوات الصغيره/i.test(normalized)) { section = "العبوات الصغيرة"; continue; }
      if (line.length >= 2 && line.length <= 100 && !/^\d/.test(toAsciiDigits(line))) {
        const header = line.split(/[–—-]/)[0].trim();
        if (/^(أسعار|اسعار)/i.test(header)) company = header.replace(/^(أسعار|اسعار)\s*/i, "").trim() || company;
        else if (header) company = header;
      }
      continue;
    }
    const priceTokens = getPriceTokens(line);
    if (!priceTokens.length) continue;
    const weightMatch = toAsciiDigits(line).match(WEIGHT_TOKEN);
    const quantity = weightMatch ? parseQuantity(weightMatch[0]) : null;
    const countMatch = toAsciiDigits(line).match(/(?:^|\s)(\d+)\s*(?:ق|قط|قطعه|قطعة)(?=\s|$)/i);
    const packCount = countMatch ? Number(countMatch[1]) : null;
    const wholesaleIndex = line.search(WHOLESALE_LABEL);
    const consumerIndex = line.search(RETAIL_LABEL);
    const afterWholesale = wholesaleIndex >= 0 ? getPriceTokens(line.slice(wholesaleIndex + line.slice(wholesaleIndex).match(WHOLESALE_LABEL)[0].length))[0]?.value ?? null : null;
    const afterConsumer = consumerIndex >= 0 ? getPriceTokens(line.slice(consumerIndex + line.slice(consumerIndex).match(RETAIL_LABEL)[0].length))[0]?.value ?? null : null;
    const beforeLabel = priceTokens.find(p => (wholesaleIndex < 0 || p.index < wholesaleIndex) && (consumerIndex < 0 || p.index < consumerIndex));
    const packagePrice = beforeLabel?.value ?? null;
    const productPrefix = cleanProductName(line);
    const weightLabel = weightMatch ? weightMatch[0].trim() : "وزن غير محدد";
    const product = [company, section, productPrefix, weightLabel].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const identityText = normalizeArabic(productPrefix);
    const isNumericOnly = !/[a-z\u0600-\u06ff]/i.test(identityText.replace(/\s/g, ""));
    const normalizedLine = normalizeArabic(line);
    const hasKnownLabel = Boolean(company || section || /اريال|اريل|بونكس|تايد|بيرل|برسيل|بركس|بريكس/.test(normalizedLine));
    const hasIdentity = Boolean(company && section && weightMatch) || (!isNumericOnly && hasKnownLabel);
    const decision = packagePrice && hasIdentity ? "accepted" : (packagePrice && !isNumericOnly ? "review" : "skipped");
    out.push({
      raw_line: line, product, variant: section || null, company,
      weight_g: quantity?.grams ?? null, volume_ml: quantity?.milliliters ?? null,
      pack_count: packCount, package_sale_price: packagePrice,
      wholesale_carton_price: afterWholesale, consumer_price: afterConsumer,
      list_price: null, confidence: decision === "accepted" ? 0.93 : decision === "review" ? 0.58 : 0.1,
      decision
    });
  }
  return out;
}
async function extractList(ai, text) {
  if (!ai?.generate) return { company: null, items: deterministicList(text), method: "deterministic" };
  try {
    const result = await ai.generate(buildListPrompt(text), { temperature: 0 });
    const parsed = parseAIJson(result.text);
    // Guard AI output against missing identity and non-positive prices; preserve skipped rows for audit.
    parsed.items = parsed.items.map(item => {
      const price = Number(item.package_sale_price);
      const product = String(item.product || "").trim();
      if (!product || !Number.isFinite(price) || price <= 0) return { ...item, decision: "skipped" };
      return { ...item, decision: ["accepted", "review", "skipped"].includes(item.decision) ? item.decision : "review" };
    });
    return { ...parsed, method: result.provider || "ai" };
  } catch (error) { return { company: null, items: deterministicList(text), method: "fallback", error: error.message }; }
}
module.exports = { isListLike, buildListPrompt, deterministicList, extractList, parseAIJson, getPriceTokens, cleanProductName };
