"use strict";

const { validateDeal } = require("./deals");
const { normalizeArabic, toAsciiDigits } = require("../core/normalization");
const { redactString } = require("../core/diagnostics");

const SOURCES = Object.freeze({
  amazon: { host: "www.amazon.eg", base: "https://www.amazon.eg/s?k=" },
  jumia: { host: "www.jumia.com.eg", base: "https://www.jumia.com.eg/catalog/?q=" },
  noon: { host: "www.noon.com", base: "https://www.noon.com/egypt-ar/search/?q=" }
});
const INCLUDE = /غسيل|مسحوق|بودر|جل|منعم|كلور|صابون|شامبو|كريم|مناديل|حفاض|فاين|ديتول|فيري|بريل|برسيل|تايد|اريال|آريال|اومو|أومو|كلوركس|دوف|لوكس|بانتين|بامبرز|مولفكس|محارم|غسول|مرطب|عناية|ورقي|مكياج|تجميل|لوشن|سيروم|مزيل عرق|معجون|فازلين|نيفيا/i;
const EXCLUDE = /tv|لابتوب|موبايل|تليفون|ساعة ذكية|سماعات|ملابس|حذاء|مكيف|ثلاجة|تلفزيون|ايفون|سامسونج جالكسي/i;
function categoryOf(title) {
  const s = normalizeArabic(title);
  if (/حفاض|بامبرز|مولفكس|مناديل|فاين|محارم|كلينكس|ورقي/.test(s)) return "paper";
  if (/صابون|شامبو|كريم|غسول|مرطب|دوف|لوكس|بانتين|عنايه|مكياج|تجميل|لوشن|سيروم|مزيل عرق|فازلين|نيفيا/.test(s)) return "personal_care";
  return "detergent";
}
function htmlText(value) { return String(value || "").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#x27;|&#39;/gi,"'").replace(/\s+/g," ").trim(); }
function money(value) {
  const s = toAsciiDigits(String(value || "")).replace(/,/g, "");
  const n = Number((s.match(/\d+(?:\.\d+)?/) || [])[0]);
  return Number.isFinite(n) && n >= 1 && n <= 200000 ? n : null;
}
function safeProductUrl(raw, sourceName) {
  try {
    const u = new URL(raw, `https://${SOURCES[sourceName].host}`);
    if (u.protocol !== "https:" || u.hostname !== SOURCES[sourceName].host || u.username || u.password) return null;
    u.hash = "";
    // Strip tracking parameters; preserve only the path and essential product identifier.
    if (sourceName === "amazon" && /\/dp\/[A-Z0-9]{10}/i.test(u.pathname)) u.search = "";
    else if (sourceName === "jumia" || sourceName === "noon") u.search = "";
    return u.toString();
  } catch { return null; }
}
function extractCards(html, sourceName, query = "") {
  const source = SOURCES[sourceName];
  if (!source || typeof html !== "string") return [];
  const cards = [];
  let chunks = [];
  if (sourceName === "amazon") chunks = [...html.matchAll(/<div[^>]+data-component-type=["']s-search-result["'][\s\S]*?<\/div>\s*<\/div>/gi)].map(m=>m[0]);
  else if (sourceName === "jumia") chunks = [...html.matchAll(/<article[^>]+class=["'][^"']*prd[^"']*["'][\s\S]*?<\/article>/gi)].map(m=>m[0]);
  else chunks = [...html.matchAll(/<article[\s\S]*?<\/article>/gi)].map(m=>m[0]);
  for (const chunk of chunks) {
    const titleMatch = chunk.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/h2>/i) || chunk.match(/(?:data-qa=["']product-name["'][^>]*>|class=["']name["'][^>]*>)([\s\S]*?)<\//i);
    const title = htmlText(titleMatch?.[1] || "");
    if (title.length < 4 || !INCLUDE.test(title) || EXCLUDE.test(title)) continue;
    const href = chunk.match(/<a[^>]+href=["']([^"']+)["']/i)?.[1];
    const url = safeProductUrl(href || "", sourceName);
    const priceMatch = sourceName === "amazon"
      ? (chunk.match(/class=["']a-price-whole["'][^>]*>([\s\S]*?)<\//i) || chunk.match(/class=["']a-offscreen["'][^>]*>([\s\S]*?)<\//i))
      : (chunk.match(/class=["'](?:prc|priceNow|price)["'][^>]*>([\s\S]*?)<\//i) || chunk.match(/data-qa=["']product-price["'][^>]*>([\s\S]*?)<\//i));
    const price = money(htmlText(priceMatch?.[1] || ""));
    const oldMatch = chunk.match(/class=["'][^"']*(?:old|oldPrice|price-was)[^"']*["'][^>]*>([\s\S]*?)<\//i);
    const oldPrice = money(htmlText(oldMatch?.[1] || ""));
    if (!url || !price) continue;
    const deal = { merchant: sourceName === "amazon" ? "Amazon.eg" : sourceName === "jumia" ? "Jumia Egypt" : "Noon Egypt", title: title.slice(0,180), url, price, old_price: oldPrice > price ? oldPrice : null, discount_pct: oldPrice > price ? Math.round((oldPrice-price)/oldPrice*10000)/100 : 0, category: categoryOf(title), query };
    if (validateDeal(deal).ok) cards.push(deal);
  }
  return cards;
}
async function fetchSearch(sourceName, query, { timeoutMs = 25000, fetchImpl = globalThis.fetch } = {}) {
  const source = SOURCES[sourceName];
  if (!source) throw new Error("unsupported_deal_source");
  const key = String(process.env.SCRAPER_API_KEY || "").trim();
  if (!key) return { source: sourceName, ok: false, reason: "SCRAPER_API_KEY_not_configured", deals: [] };
  const targetUrl = `${source.base}${encodeURIComponent(query)}`;
  const endpoint = new URL("https://api.scraperapi.com/");
  endpoint.searchParams.set("api_key", key);
  endpoint.searchParams.set("url", targetUrl);
  endpoint.searchParams.set("country_code", "eg");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, { signal: controller.signal, redirect: "error" });
    if (!response.ok) return { source: sourceName, ok: false, reason: `http_${response.status}`, deals: [] };
    const html = await response.text();
    return { source: sourceName, ok: true, deals: extractCards(html, sourceName, query) };
  } catch (error) { return { source: sourceName, ok: false, reason: error.name === "AbortError" ? "timeout" : "fetch_failed", error: redactString(error?.message || "fetch_failed"), deals: [] }; }
  finally { clearTimeout(timer); }
}
async function collectDealCandidates({ amazonQueries = ["مسحوق غسيل منظف", "مناديل ورقية", "شامبو صابون كريم"], otherQueries = ["مسحوق غسيل منظف", "مناديل ورقية", "شامبو صابون كريم"], fetchImpl } = {}) {
  const tasks = [];
  for (const q of amazonQueries) tasks.push(fetchSearch("amazon", q, { fetchImpl }));
  for (const q of otherQueries) for (const source of ["jumia", "noon"]) tasks.push(fetchSearch(source, q, { fetchImpl }));
  const results = await Promise.allSettled(tasks);
  const deals = [], errors = [];
  const seen = new Set();
  for (const r of results) {
    if (r.status !== "fulfilled") { errors.push({ reason: "task_rejected" }); continue; }
    if (!r.value.ok) { errors.push({ source: r.value.source, reason: r.value.reason }); continue; }
    for (const d of r.value.deals) {
      const key = `${d.url}|${d.price}`;
      if (!seen.has(key)) { seen.add(key); deals.push(d); }
    }
  }
  return { deals, errors, sourceCount: tasks.length };
}
module.exports = { SOURCES, categoryOf, safeProductUrl, extractCards, fetchSearch, collectDealCandidates };
