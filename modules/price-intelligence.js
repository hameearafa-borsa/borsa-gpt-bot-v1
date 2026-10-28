"use strict";

const crypto = require("node:crypto");
const { normalizeArabic, toAsciiDigits, parseNumber, parseQuantity } = require("../core/normalization");

const RETAIL_WORDS = /(?:مستهلك|قطاعي|تجزئ|بيع|للمستهلك|رف|تجزئة)/i;
const WHOLESALE_WORDS = /(?:جمله|جملة|كرتونه|كرتونة|فاتوره|فاتورة|تاجر|جمله|سعر الاساس|السعر الاساسى)/i;
const PACK_RE = /(?:\*|×)\s*(\d+)\s*(?:ق|قط|قطعه|قطعة|كيس|جوال|شكاره|شكارة|زجاجه|زجاجة|زجاجات|جركن|عبوه|عبوة|عبوات)?|(?:^|\s)x\s*(\d+)\s*(?=(?:ق|قط|قطعه|قطعة|كيس|جوال|شكاره|شكارة|زجاجه|زجاجة|زجاجات|جركن|عبوه|عبوة|عبوات|$))/i;
const PACK_ANY_RE = /(?:^|\s)(\d+)\s*(?:ق|قط|قطعه|قطعة|كيس|جوال|شكاره|شكارة|زجاجه|زجاجة|زجاجات|جركن|عبوه|عبوة|عبوات)(?=\s|$)/i;
const EXTRA_RE = /(?:\+|زائد|زياده|زيادة)\s*(\d+(?:[.,]\d+)?)\s*(كيلو|كجم|ك|جرام|جم|g|kg)/i;

function classifyPriceKind(text) {
  const s = normalizeArabic(text);
  if (RETAIL_WORDS.test(s) && !WHOLESALE_WORDS.test(s)) return "retail";
  if (WHOLESALE_WORDS.test(s)) return "wholesale";
  return "unknown";
}

function parsePackCount(text) {
  const s = toAsciiDigits(text);
  const m = s.match(PACK_RE) || s.match(PACK_ANY_RE);
  if (!m) return null;
  const n = m[1] ?? m[2];
  return n ? Number(n) : null;
}

function parseExtraWeight(text) {
  const m = toAsciiDigits(String(text || "")).match(EXTRA_RE);
  if (!m) return null;
  const q = parseQuantity(`${m[1]} ${m[2]}`);
  return q?.grams ?? null;
}

function stripQuantityTokens(text) {
  return String(text || "")
    .replace(/\d+(?:[.,]\d+)?\s*(?:كيلو|كجم|ك|kg|جرام|جم|g|لتر|ل|liter|l|مل|ml)/gi, " ")
    .replace(PACK_RE, " ")
    .replace(PACK_ANY_RE, " ")
    .replace(EXTRA_RE, " ")
    // In Unilever-style lists, standalone "ق" means per piece, not part of the product name.
    .replace(/(?:^|\s)ق(?=\s|$)/giu, " ");
}

function numericPriceTokens(text) {
  const s = toAsciiDigits(text);
  const attached = [...s.matchAll(/((?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?))\s*(?:جنيه|ج|EGP)(?=\s|\||$)/gi)].map(m => parseNumber(m[1]));
  const standalone = [...s.matchAll(/(?:^|\s|\|)((?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?))(?=\s|\||$)/gi)].map(m => parseNumber(m[1]));
  return [...attached, ...standalone].filter(n => n != null && n > 0 && n < 100000);
}

 
function extractInvoicePriceAfterTax(text) {
  // Invoice exports often include product sizes and a separate offer-value field.
  // Prefer the amount explicitly labelled as the final invoice price after VAT,
  // rather than treating a size or "قيمة العرض" number as the sale price.
  // Do not normalize punctuation before extracting the amount: Arabic normalization turns a thousands comma into whitespace.
  const normalized = toAsciiDigits(String(text || "")).replace(/[\u200B-\u200F\uFEFF]/g, "");
  const match = normalized.match(/سعر\s+الفاتور[هة]\s+بعد\s*\d+(?:[.,]\d+)?\s*%\s*[:：-]?\s*((?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?))/iu);
  const value = match ? parseNumber(match[1]) : null;
  return value != null && value > 0 && value < 100000 ? value : null;
}

function selectSalePrice(text, fallbackPrices) {
  // A specifically labelled final invoice amount takes precedence over sizes,
  // offer-value fields, and other unlabelled numbers on the same row.
  const invoicePrice = extractInvoicePriceAfterTax(text);
  if (invoicePrice != null) return invoicePrice;
  // The monitor is a wholesale-price monitor: when a row explicitly labels a
  // value "جملة", that value wins. Preserve any earlier unlabelled amount in a
  // separate field rather than silently treating it as the wholesale price.
  const explicitWholesale = extractExplicitWholesalePrice(text);
  if (explicitWholesale != null) return explicitWholesale;
  return fallbackPrices[0] ?? null;
}

function extractExplicitWholesalePrice(text) {
  const match = toAsciiDigits(text).match(/(?:جمله|جملة)\s*[:：]?\s*((?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?))/i);
  const value = match ? parseNumber(match[1]) : null;
  return value != null && value > 0 && value < 100000 ? value : null;
}

function extractProductText(line) {
  return stripQuantityTokens(line)
    .replace(/\d+(?:[.,]\d+)?\s*(?:ج|جنيه|EGP)?/gi, " ")
    .replace(/\|/g, " ")
    .replace(/[+]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^(?:[-•.*]+)\s*/, "")
    .trim();
}

function extractInvoiceProductText(line) {
  // Invoice exports may bold a variant number without including its unit,
  // e.g. "**دوش** **60**. Preserve that number in the product identity rather
  // than guessing a unit or merging it with another variant such as "دوش 110".
  const prefix = String(line || "")
    .replace(/[\u200B-\u200F\uFEFF]/g, "")
    .replace(/\*\*/g, "")
    .split(/\s*(?:-\s*)?(?:قيمه العرض|قيمة العرض|سعر الفاتوره|سعر الفاتورة)/iu)[0]
    .replace(/^(?:\s*[-•.*]+\s*)/, "")
    .trim();
  return stripQuantityTokens(prefix).replace(/\s+/g, " ").trim();
}

function parseStructuredPriceTable(text) {
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const headerIndex = lines.findIndex(line => {
    const header = normalizeArabic(line);
    return header.includes("عدد القطع") &&
      header.includes("السعر الصافي بعد الخصم") &&
      header.includes("صافي سعر القطعه");
  });
  if (headerIndex < 0) return null;

  const rows = [];
  let company = null;
  let section = null;
  let offerContext = null;
  const amount = "[\\d,]+(?:\\.\\d{1,2})?";
  const rowPattern = new RegExp("^(.*?)\\s+(\\d+)\\s+(" + amount + ")\\s+(" + amount + ")$");
  for (const line of lines.slice(0, headerIndex)) {
    if (/^تصفية اسعار|^اسعار شركة|^أسعار شركة/u.test(line)) company = line.trim();
  }
  for (const line of lines.slice(headerIndex + 1)) {
    const normalized = normalizeArabic(line);
    if (/^(?:عرض|العرض|عرض التوفير|عرض باهي|عرض توفير)/u.test(normalized)) {
      offerContext = line;
      continue;
    }
    if (/^(?:الصابون الريحه|الباهي اليدوي|الباهي الاوتوماتيك|مجموعه الجيل العادي|مجموعة الجيل العادي|مجموعه الوفير|مجموعة الوفير|الهاند ووش|الشامبو|المنظفات)/u.test(normalized)) {
      section = line;
      if (!/^عرض/u.test(normalized)) offerContext = null;
      continue;
    }
    const match = line.match(rowPattern);
    if (!match) {
      if (!/\d/.test(line) && /^(?:الصابون|الباهي|مجموعة|مجموعه|الهاند|الشاور|الجل|الوفير|برايت)/u.test(normalized)) offerContext = null;
      continue;
    }
    let productText = match[1].trim().replace(/^[•*\-]+\s*/, "");
    if (/^باهي\s+جرام$/u.test(normalizeArabic(productText)) &&
        /شراء\s*3\s*كرتون/u.test(normalizeArabic(offerContext || ""))) {
      productText = "باهي 2000 جرام";
    }
    const packCount = Number(match[2]);
    const casePrice = Number(match[3].replace(/,/g, ""));
    const piecePrice = Number(match[4].replace(/,/g, ""));
    if (!productText || !Number.isFinite(casePrice) || !Number.isFinite(piecePrice)) continue;
    const quantityMatch = productText.match(/\d+(?:[.,]\d+)?\s*(?:كيلو|كجم|ك|kg|جرام|جم|g|لتر|ل|liter|l|مل|ml)/i);
    const quantity = quantityMatch ? parseQuantity(quantityMatch[0]) : null;
    const extraWeight = parseExtraWeight(productText);
    const fullProductText = offerContext ? productText + " — " + offerContext : productText;
    rows.push({
      raw_line: line, company, section, product_text: fullProductText,
      package_sale_price: casePrice, listed_base_price: piecePrice,
      explicit_wholesale_label_price: null, consumer_price: null,
      price_kind: "wholesale",
      weight_g: quantity?.grams ?? null, volume_ml: quantity?.milliliters ?? null,
      offer_extra_weight_g: extraWeight, pack_count: packCount,
      package_type: parsePackageType(productText), confidence: 0.99,
      trusted_catalog_row: true,
      needs_review: false,
      price_selection_reason: "trusted_structured_catalog_case_total_and_piece_price_preserved"
    });
  }
  return rows;
}

function parseInvoiceTable(text) {
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const normalizedAll = normalizeArabic(lines.join(" "));
  const hasInvoiceHeader = normalizedAll.includes("سعر الفاتوره بعد 14") &&
    normalizedAll.includes("العرض الترويجي") && normalizedAll.includes("الصنف");
  if (!hasInvoiceHeader) return null;

  const rows = [];
  let current = [];
  // Header labels may be printed on separate lines in copied/OCR invoices.
  // Once the whole document confirms the invoice schema, begin row parsing
  // immediately and skip the individual header lines below.
  let inRows = hasInvoiceHeader;
  let section = null;
  const amountLine = /^(?:ج\s*)?([\d,]+(?:\.\d{1,2})?)(?:\s*(?:جنيه|ج|egp))?$/iu;
  const flush = (amountText) => {
    if (!current.length) return;
    const rawProduct = current.join(" ").replace(/\s+/g, " ").trim();
    current = [];
    const amountMatch = String(amountText || "").match(amountLine);
    if (!rawProduct || !amountMatch) return;
    const price = Number(amountMatch[1].replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0 || price >= 100000) return;

    const packCount = parsePackCount(rawProduct);
    const quantityMatch = toAsciiDigits(rawProduct).match(/\d+(?:[.,]\d+)?\s*(?:كيلو|كجم|ك|kg|جرام|جم|غرام|g|لتر|ل|liter|l|مل|ملل|ml)/iu);
    const quantity = quantityMatch ? parseQuantity(quantityMatch[0]) : null;
    const productText = rawProduct
      .replace(/(?:^|\s)(\d+)\s*(?:ق|قط|قطعه|قطعة|كيس|جوال|شكاره|شكارة|زجاجه|زجاجة|جركن|عبوه|عبوة)(?=\s|$)/iu, " ")
      .replace(/\s+/g, " ").trim();
    const normalizedName = normalizeArabic(productText);
    if (!normalizedName || !/[\p{L}]/u.test(normalizedName)) return;
    rows.push({
      raw_line: rawProduct + " | " + amountText,
      company: null,
      section,
      product_text: productText,
      package_sale_price: price,
      listed_base_price: null,
      explicit_wholesale_label_price: null,
      consumer_price: null,
      price_kind: "wholesale",
      weight_g: quantity?.grams ?? null,
      volume_ml: quantity?.milliliters ?? null,
      offer_extra_weight_g: parseExtraWeight(rawProduct),
      pack_count: packCount,
      package_type: parsePackageType(rawProduct) || (/زجاجه|زجاجة/iu.test(rawProduct) ? "bottle" : /جركن/iu.test(rawProduct) ? "jerrycan" : /عبوه|عبوة/iu.test(rawProduct) ? "container" : null),
      confidence: 0.99,
      trusted_catalog_row: true,
      needs_review: false,
      price_selection_reason: "trusted_invoice_total_after_vat_and_promotion; preserve_package_count_and_size"
    });
  };

  for (const line of lines) {
    const normalized = normalizeArabic(line);
    if (!inRows) {
      if (normalized.includes("الصنف") && normalized.includes("سعر الفاتوره بعد 14") && normalized.includes("العرض الترويجي")) inRows = true;
      continue;
    }
    if (/^(?:اجمالي|الإجمالي|المجموع|total)\b/iu.test(normalized)) {
      flush("");
      break;
    }
    const amountMatch = line.match(amountLine);
    if (amountMatch) {
      flush(line);
      continue;
    }
    // Arabic letters are not reliably delimited by JavaScript's ASCII-oriented \\b.
    // Invoice exports may put all column headings on one line or split them across lines.
    if (
      (normalized.includes("الصنف") && normalized.includes("سعر الفاتوره") && normalized.includes("العرض الترويجي")) ||
      normalized.startsWith("سعر الفاتوره") ||
      normalized.startsWith("العرض الترويجي") ||
      normalized === "الصنف"
    ) continue;
    if (/^(?:قسم|المجموعه|المجموعة|منظفات|صابون|شامبو|منعم)/iu.test(normalized) && !/\d/u.test(line)) {
      if (current.length) current.push(line);
      else section = line;
      continue;
    }
    current.push(line.replace(/^[-•*]+\s*/, ""));
  }
  flush("");
  return rows.length ? rows : null;
}

function extractPriceCandidates(text) {
  const lines = String(text || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const invoiceRows = parseInvoiceTable(text);
  if (invoiceRows) return invoiceRows;
  const structuredRows = parseStructuredPriceTable(text);
  if (structuredRows) return structuredRows;
  const out = [];
  let company = null;
  let section = null;

  for (const line of lines) {
    if (/^\/|^[-_=.*]+$/.test(line)) continue;
    if (/^(?:شهر\s+)?(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)\s+20\d{2}$/iu.test(line)) continue;

    const normalized = normalizeArabic(line);
    const parsedLine = toAsciiDigits(line).replace(/\*\*/g, "").replace(/[\u200B-\u200F\uFEFF]/g, "");
    const stripped = stripQuantityTokens(parsedLine);
    const numbers = numericPriceTokens(stripped);

    // Company and section headings establish context for weight-only rows such as "9 ك:".
    if (!numbers.length) {
      if (/^(?:الاسعار?|اسعار)\s*(?:هي\s*)?(?:جمله|قطاعي|مستهلك)$/iu.test(normalized)) continue;
      if (/^(?:اسعار)\s+/iu.test(normalized)) {
        const heading = line.replace(/^(?:أسعار|اسعار)\s+/iu, "").split(/[–—-]/)[0].trim();
        company = heading.replace(/^شركة\s+/iu, "").trim() || company;
        continue;
      }
      if (/اوتوماتيك|automatic/u.test(normalized)) { section = "أوتوماتيك"; continue; }
      if (/اوزان|شكاير|شكاره/u.test(normalized)) { section = "أوزان وشكاير"; continue; }
      if (/عبوات صغيره|العبوات الصغيره/u.test(normalized)) { section = "العبوات الصغيرة"; continue; }
      continue;
    }

    const kind = classifyPriceKind(line);
    const retailIndex = parsedLine.search(RETAIL_WORDS);
    const beforeRetail = retailIndex >= 0 ? parsedLine.slice(0, retailIndex) : parsedLine;
    const preRetailNumbers = numericPriceTokens(stripQuantityTokens(beforeRetail));
    // Skip retail-only observations, but keep a valid base/package price that precedes
    // a separate consumer-price column (e.g. "شكارة 10 ك: 618.35 | مستهلك 630").
    if (kind === "retail" && (preRetailNumbers.length === 0 || numbers.length <= preRetailNumbers.length)) continue;

    const packCount = parsePackCount(parsedLine);
    const extraWeightG = parseExtraWeight(parsedLine);
    const quantity = parsedLine.match(/\d+(?:[.,]\d+)?\s*(?:كيلو|كجم|ك|kg|جرام|جم|g|لتر|ل|liter|l|مل|ml)/i);
    const q = quantity ? parseQuantity(quantity[0]) : null;
    const decimalAutomaticWeight = parsedLine.match(/(?:^|\s)(\d+[.,]\d{1,3})\s*(?:كجم|ك)?\s*(?:اتوماتيك|اوتوماتيك)/i);
    const decimalAutomaticGrams = decimalAutomaticWeight ? Math.round(Number(decimalAutomaticWeight[1].replace(",", ".")) * 1000) : null;

    const explicitWholesalePrice = extractExplicitWholesalePrice(parsedLine);
    const explicitWholesale = explicitWholesalePrice != null;
    const wholesaleLabelIndex = stripped.search(/(?:جمله|جملة)\s*[:：]?/i);
    const preWholesalePrices = wholesaleLabelIndex >= 0
      ? numericPriceTokens(stripped.slice(0, wholesaleLabelIndex))
      : [];
    const unlabelledPriceBeforeWholesale = preWholesalePrices.length
      ? preWholesalePrices[preWholesalePrices.length - 1]
      : null;
    const salePrice = selectSalePrice(stripped, numbers);
    if (salePrice == null) continue;

    const consumerIndex = parsedLine.search(RETAIL_WORDS);
    const consumerSuffix = consumerIndex >= 0
      ? parsedLine.slice(consumerIndex).replace(RETAIL_WORDS, " ")
      : "";
    const consumerPrice = numericPriceTokens(stripQuantityTokens(consumerSuffix))[0] ?? null;

    const invoiceLabelledPrice = extractInvoicePriceAfterTax(parsedLine);
    const candidateName = (invoiceLabelledPrice != null
      ? extractInvoiceProductText(parsedLine)
      : extractProductText(parsedLine))
      .replace(/(?:جمله|جملة|مستهلك|قطاعي|تجزئه|تجزئة|سعر الاساس|السعر الاساسى|قيمه العرض|قيمة العرض|سعر الفاتوره|سعر الفاتورة|بعد)/giu, " ")
      .replace(/\s+/g, " ").trim();
    const weightLabel = quantity?.[0]?.trim() || (decimalAutomaticWeight ? decimalAutomaticWeight[1] : null);
    // Generic package words describe packaging, not the product identity.
    // For weight-only catalog rows (e.g. "شكارة 10 ك") preserve company/section/weight context.
    const normalizedCandidateName = normalizeArabic(candidateName);
    const meaningfulCandidateName = normalizedCandidateName.replace(/[^\p{L}\p{N}]/gu, "");
    const genericPackageOnly = /^(?:شكاره|شوال|كيس|ساشيه)$/iu.test(normalizedCandidateName);
    let productText = meaningfulCandidateName.length >= 2 && !genericPackageOnly
      ? candidateName
      : [company, section, weightLabel].filter(Boolean).join(" ").trim();
    let inferredWeightG = q?.grams ?? decimalAutomaticGrams;
    // User-confirmed product-specific convention: in invoice rows, a bare
    // number after "دوش" is the soap weight in grams (e.g. "دوش 60" => "دوش 60 جرام").
    // Do not generalize this rule to other brands or products.
    const doushWeight = parsedLine.match(/^\s*(?:[-•*]+\s*)?دوش\s+(\d{1,4})(?!\s*(?:جرام|جم|غرام|كجم|كيلو|ك|g|kg)\b)/iu);
    if (doushWeight) {
      // Apply the confirmed convention to invoice rows and ordinary price rows,
      // while leaving explicit units untouched.
      productText = `دوش ${doushWeight[1]} جرام`;
      inferredWeightG = Number(doushWeight[1]);
    }
    const normalizedProduct = normalizeArabic(productText);
    if (normalizedProduct.length < 2 || /^\d/.test(normalizedProduct)) continue;

    const priceKind = explicitWholesale ? "wholesale" : "wholesale_candidate";
    out.push({
      raw_line: line,
      company,
      section,
      product_text: productText,
      package_sale_price: salePrice,
      // Preserve the first/unlabelled amount; do not confuse it with the
      // explicitly labelled wholesale value used by the monitoring pipeline.
      listed_base_price: explicitWholesale ? unlabelledPriceBeforeWholesale : null,
      explicit_wholesale_label_price: explicitWholesalePrice,
      consumer_price: consumerPrice,
      price_kind: priceKind,
      weight_g: inferredWeightG,
      volume_ml: q?.milliliters ?? null,
      offer_extra_weight_g: extraWeightG,
      pack_count: packCount,
      package_type: parsePackageType(line),
      confidence: explicitWholesale && unlabelledPriceBeforeWholesale != null && unlabelledPriceBeforeWholesale !== explicitWholesalePrice
        ? 0.72
        : explicitWholesale ? 0.92 : (consumerIndex >= 0 ? 0.65 : 0.55),
      needs_review: explicitWholesale && unlabelledPriceBeforeWholesale != null && unlabelledPriceBeforeWholesale !== explicitWholesalePrice,
      price_selection_reason: explicitWholesale && unlabelledPriceBeforeWholesale != null && unlabelledPriceBeforeWholesale !== explicitWholesalePrice
        ? "explicit_wholesale_selected; unlabelled_pre_wholesale_price_preserved_for_review"
        : explicitWholesale ? "explicit_wholesale_label" : "first_price_candidate",
    });
  }

  // Infer a missing row-level price label from the same company + section when
  // neighbouring rows consistently expose a labelled wholesale column.
  // This is contextual classification only; it never changes any raw amount.
  const contextGroups = new Map();
  for (const row of out) {
    if (row.explicit_wholesale_label_price == null || !row.company || !row.section) continue;
    const key = `${normalizeArabic(row.company)}|${normalizeArabic(row.section)}`;
    contextGroups.set(key, (contextGroups.get(key) || 0) + 1);
  }
  for (const row of out) {
    const key = `${normalizeArabic(row.company || "")}|${normalizeArabic(row.section || "")}`;
    if (row.explicit_wholesale_label_price != null || !contextGroups.get(key)) continue;
    row.price_kind = "wholesale";
    row.context_inferred_price_kind = true;
    row.needs_review = true;
    row.confidence = Math.max(Number(row.confidence) || 0, 0.72);
    row.price_selection_reason = "section_context_inferred_wholesale; first_package_price_preserved";
  }
  return out;
}
function parsePackageType(text) {
  const s = normalizeArabic(text);
  if (/(?:شكاره|شوال)/u.test(s)) return "sack";
  if (/(?:كيس|ساشيه)/u.test(s)) return "sachet";
  return null;
}

function productIdentityKey(row) {
  const normalizedName = normalizeArabic(row?.product_text || "");
  // Doush soap variants use a bare number as grams in invoice exports.
  // Preserve that product-specific size in the identity so 60 g and 110 g
  // occupy separate price histories instead of appearing as a weight change.
  const doushVariant = normalizedName.match(/^دوش\s+(\d{1,4})\s+جرام$/u);
  const stableName = doushVariant
    ? normalizedName
    : normalizeArabic(stripQuantityTokens(row?.product_text || ""));
  // Dimensions belong to identity: the same brand/name at 500 g and 1 kg, or in different carton counts, must not share one price history.
  const dimensions = [row?.weight_g, row?.volume_ml, row?.offer_extra_weight_g, row?.pack_count, row?.package_type]
    .map(value => value == null || value === "" ? "" : String(value));
  return [String(row?.brand_key || ""), stableName, String(row?.price_kind || ""), ...dimensions].join("|");
}

function classifyObservationChange(previous, current) {
  if (!previous) return "new_observation";
  const previousIdentity = previous.product_identity_key || productIdentityKey(previous);
  const currentIdentity = current.product_identity_key || productIdentityKey(current);
  if (previousIdentity !== currentIdentity) return "new_observation";

  const sameNumber = (a, b) => {
    const av = a == null || a === "" ? null : Number(a);
    const bv = b == null || b === "" ? null : Number(b);
    if (av == null || bv == null) return av === bv;
    return Number.isFinite(av) && Number.isFinite(bv) && Math.abs(av - bv) < 0.0005;
  };
  const dimensions = ["weight_g", "volume_ml", "offer_extra_weight_g", "pack_count"];
  const weightChanged = dimensions.some(key => !sameNumber(previous[key], current[key])) ||
    String(previous.package_type || "") !== String(current.package_type || "");
  const priceChanged = !sameNumber(previous.package_sale_price, current.package_sale_price);

  if (weightChanged && priceChanged) return "price_and_weight_change";
  if (weightChanged) return "weight_change";
  if (priceChanged) return "price_change";
  return "same_observation";
}

function commercialMetrics(row) {
  const weight = Number(row.weight_g) || 0;
  const extra = Number(row.offer_extra_weight_g) || 0;
  const price = Number(row.package_sale_price) || 0;
  const count = Number(row.pack_count) || 1;
  const totalWeight = weight + extra;
  return {
    package_sale_price: price,
    piece_sale_price: count > 1 ? price / count : price,
    effective_weight_g: totalWeight || null,
    effective_price_per_kg: totalWeight > 0 ? price / (totalWeight / 1000) : null,
    effective_volume_ml: Number(row.volume_ml) || null,
  };
}

function fingerprint(row) {
  return crypto.createHash("sha256").update([
    normalizeArabic(row.product_text), row.weight_g || "", row.volume_ml || "", row.offer_extra_weight_g || "",
    row.pack_count || "", row.package_sale_price || "", row.price_kind || ""
  ].join("|")).digest("hex");
}

module.exports = { classifyPriceKind, parsePackCount, parseExtraWeight, parsePackageType, productIdentityKey, classifyObservationChange, extractPriceCandidates, parseStructuredPriceTable, parseInvoiceTable, commercialMetrics, fingerprint, extractInvoicePriceAfterTax };
