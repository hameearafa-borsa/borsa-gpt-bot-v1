"use strict";

/**
 * عروض حقيقية من متاجر مصر (أمازون، نون، جوميا، كارفور، كازيون)
 * للمشرفين فقط — تُنشر في الشات الذي يُستدعى منه الأمر.
 */

const axios = require("axios");

const DEAL_HOSTS = [
  "amazon.eg",
  "amazon.com",
  "amzn.eg",
  "amzn.to",
  "a.co",
  "noon.com",
  "noon.partners",
  "jumia.com.eg",
  "jumia.com",
  "jumia.eg",
  "carrefouregypt.com",
  "carrefour.com.eg",
  "kazyon.com",
  "kazyon.app",
];

const SEARCH_PAGES = [
  "https://www.amazon.eg/s?k=%D9%85%D9%86%D8%B8%D9%81%D8%A7%D8%AA",
  "https://www.noon.com/egypt-ar/search/?q=%D9%85%D9%86%D8%B8%D9%81%D8%A7%D8%AA",
  "https://www.jumia.com.eg/catalog/?q=%D9%85%D9%86%D8%B8%D9%81%D8%A7%D8%AA",
  "https://www.carrefouregypt.com/mafegy/ar/search?keyword=%D9%85%D9%86%D8%B8%D9%81%D8%A7%D8%AA",
];

const DEAL_SCHEMA = {
  type: "array",
  description: "عروض مؤكدة بروابط مباشرة فقط",
  items: {
    type: "object",
    properties: {
      title: { type: "string" },
      store: { type: "string", enum: ["amazon.eg", "noon", "jumia", "carrefour", "kazyon"] },
      price: { type: "number" },
      old_price: { anyOf: [{ type: "number" }, { type: "null" }] },
      url: { type: "string" },
      why: { type: "string" },
    },
    required: ["title", "store", "price", "old_price", "url", "why"],
    additionalProperties: false,
  },
};

const DEAL_PROMPT = `أنت باحث عروض لمصر فقط. ابحث عن عروض سارية اليوم في:
منظفات منزلية، ورقيات (محارم/فاين)، منتجات العناية الشخصية (شامبو، صابون، جل).
المصادر المسموحة فقط:
- amazon.eg
- noon.com (مصر)
- jumia.com.eg
- carrefouregypt.com
- kazyon.com إن وُجدت صفحة منتج عامة

لا تخترع روابط ولا أسعار. تجاهل العطور الفاخرة والإلكترونيات والملابس.
- أرجع حتى 8 عروض مميزة (خصم واضح أو سعر أقل من المعتاد).
- أرجع JSON مصفوفة فقط بدون شرح:
[{"title":"اسم الصنف","store":"amazon.eg|noon|jumia|carrefour|kazyon","price":123,"old_price":null,"url":"https://...","why":"سبب أن العرض مميز"}]
إن لم تجد عرضاً مؤكداً أرجع [].`;

let d = null;
const callLog = [];

function setupDeals(deps) {
  d = deps;
}

function allowRate(limit, windowMs) {
  const now = Date.now();
  while (callLog.length && now - callLog[0] > windowMs) callLog.shift();
  if (callLog.length >= limit) return false;
  callLog.push(now);
  return true;
}

function hostOf(raw) {
  try {
    const u = new URL(String(raw).includes("://") ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isDealHost(host) {
  if (!host) return false;
  return DEAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function plausible(n) {
  const x = Number(n);
  return Number.isFinite(x) && x >= 8 && x <= 200000;
}

function storeLabel(store, host) {
  const s = String(store || host || "").toLowerCase();
  if (s.includes("amazon") || s === "amzn.to" || s === "a.co") return "أمازون";
  if (s.includes("noon")) return "نون";
  if (s.includes("jumia")) return "جوميا";
  if (s.includes("carrefour")) return "كارفور";
  if (s.includes("kazyon")) return "كازيون";
  return store || host;
}

function parseDeals(text) {
  if (!d?.parseJsonLoose) return [];
  try {
    const parsed = d.parseJsonLoose(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitize(items) {
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    const url = String(it.url || "").trim();
    const host = hostOf(url);
    const title = String(it.title || "").trim().slice(0, 90);
    const price = Number(it.price);
    if (!title || !isDealHost(host) || !plausible(price)) continue;
    const key = `${title.toLowerCase()}|${Math.round(price)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      store: storeLabel(it.store, host),
      price,
      old_price: plausible(it.old_price) ? Number(it.old_price) : null,
      url,
      why: String(it.why || "").trim().slice(0, 80),
    });
    if (out.length >= 8) break;
  }
  return out;
}

async function viaSearch() {
  const response = await d.generateWithFallback(DEAL_PROMPT, {
    tools: [{ googleSearch: {} }],
    responseMimeType: "application/json",
    responseSchema: DEAL_SCHEMA,
  });
  return parseDeals(response.text);
}

async function fetchPageText(url) {
  const res = await axios.get(url, {
    timeout: 8000,
    maxRedirects: 3,
    responseType: "text",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36",
      "Accept-Language": "ar-EG,ar;q=0.9,en;q=0.6",
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const html = String(res.data || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 5000);
}

async function viaPages() {
  const chunks = [];
  for (const url of SEARCH_PAGES) {
    try {
      chunks.push(`مصدر ${url}:\n${await fetchPageText(url)}`);
    } catch {
      /* الموقع قد يمنع الاستضافة */
    }
  }
  if (!chunks.length) return [];
  const response = await d.generateWithFallback(
    `${DEAL_PROMPT}\n\nمقتطفات الصفحات:\n${chunks.join("\n\n").slice(0, 14000)}`,
    { responseMimeType: "application/json", responseSchema: DEAL_SCHEMA }
  );
  return parseDeals(response.text);
}

async function collectDeals() {
  try {
    const fromSearch = sanitize(await viaSearch());
    if (fromSearch.length) return fromSearch;
  } catch (e) {
    console.warn("deals search", e.message);
  }
  try {
    return sanitize(await viaPages());
  } catch (e) {
    console.warn("deals pages", e.message);
    return [];
  }
}

function formatDeals(items) {
  const day = new Date().toLocaleDateString("ar-EG", {
    timeZone: "Africa/Cairo",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const lines = items.map((it) => {
    const old =
      it.old_price && it.old_price > it.price ? ` <s>${it.old_price}</s>` : "";
    const why = it.why ? `\n  <i>${d.escHtml(it.why)}</i>` : "";
    return `• <a href="${d.escHtml(it.url)}">${d.escHtml(it.title)}</a>\n  ${d.escHtml(it.store)} — <b>${it.price}</b> ج${old}${why}`;
  });
  return (
    `<b>عروض منظفات وورقيات وعناية</b> — ${d.escHtml(day)}\n` +
    `من أمازون ونون وجوميا وكارفور وكازيون عند توفر روابط مباشرة.\n\n` +
    `${lines.join("\n\n")}\n\n` +
    `<i>تحقق من السعر قبل الشراء؛ العروض تتغير بسرعة.</i>`
  );
}

async function fetchDealsReport() {
  if (!d) throw new Error("deals not setup");
  if (!allowRate(4, 60 * 60_000)) {
    return "تم طلب العروض عدة مرات خلال الساعة. انتظر قليلاً حتى لا تُستهلك حصة البحث.";
  }
  const items = await collectDeals();
  if (!items.length) {
    return "لم أجد عروضاً مؤكدة بروابط مباشرة الآن. أعد المحاولة لاحقاً أو تحقق من حالة مفاتيح AI عبر /aitest.";
  }
  return formatDeals(items);
}

module.exports = {
  setupDeals,
  fetchDealsReport,
  DEAL_HOSTS,
};
