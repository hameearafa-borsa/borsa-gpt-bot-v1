"use strict";

const { validateDeal } = require("./deals");
const { normalizeArabic, toAsciiDigits } = require("../core/normalization");
const { redactString } = require("../core/diagnostics");
const { collectSnapFlyerCatalogDeals } = require("./snapflyer-catalog-deals");

let nextScraperKeyIndex = 0;
const MAX_CONCURRENT_SCRAPER_REQUESTS = 2;
const SOURCES = Object.freeze({
  amazon: { host: "www.amazon.eg", base: "https://www.amazon.eg/s?k=" },
  jumia: { host: "www.jumia.com.eg", base: "https://www.jumia.com.eg/catalog/?q=" },
  noon: { host: "www.noon.com", base: "https://www.noon.com/egypt-ar/search/?q=" },
  carrefour: { host: "www.carrefouregypt.com", base: "https://www.carrefouregypt.com/mafegy/ar/c/promo-exclusive-online-offers" }
});
const INCLUDE = /غسيل|مسحوق|بودر|جل|منعم|كلور|صابون|شامبو|كريم|مناديل|حفاض|فاين|ديتول|فيري|بريل|برسيل|تايد|اريال|آريال|اومو|أومو|كلوركس|دوف|لوكس|بانتين|بامبرز|مولفكس|محارم|غسول|مرطب|عناية|ورقي|مكياج|تجميل|لوشن|سيروم|مزيل عرق|معجون|فازلين|نيفيا|منظف|منظفات|مطهر|معقم|سائل أطباق|سائل اطباق|سائل صحون|سائل جلي|سائل غسيل|معطر|مبيض|مزيل بقع|ورق تواليت|مناديل مطبخ|مناديل حمام|ملمع|سائل تنظيف|منظف زجاج|معجون أسنان|معجون اسنان/i;
const EXCLUDE = /tv|لابتوب|موبايل|تليفون|ساعة ذكية|سماعات|حذاء|ملابس نسائية|ملابس رجالية|ملابس أطفال|فستان|تيشيرت|بنطلون|جاكيت|مكيف|ثلاجة|تلفزيون|شاشة|ايفون|سامسونج جالكسي|غسالة ملابس|بوتاجاز|ميكروويف|مروحة|تكييف|أثاث|كنبة|سرير|مرتبة|لعبة أطفال|ألعاب أطفال|مكمل غذائي|علف|طعام قطط|طعام كلاب|كريم طبخ|كريمة طبخ|شامبو سيارات|منظف سيارات|زيت محرك/i;
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
    if (!SOURCES[sourceName] || !String(raw || "").trim()) return null;
    const u = new URL(raw, `https://${SOURCES[sourceName].host}`);
    if (u.protocol !== "https:" || u.hostname !== SOURCES[sourceName].host || u.username || u.password || (u.port && u.port !== "443") || u.pathname === "/") return null;
    u.hash = "";
    // Strip tracking parameters; preserve only the path and essential product identifier.
    if (sourceName === "amazon" && /\/dp\/[A-Z0-9]{10}/i.test(u.pathname)) u.search = "";
    else if (sourceName === "jumia" || sourceName === "noon") u.search = "";
    return u.toString();
  } catch { return null; }
}
function addRejectionSample(stats, reason, title, rawUrl) {
  if (!stats || !Array.isArray(stats.samples) || stats.samples.length >= 8) return;
  let safeUrl = "";
  try { const parsed = new URL(String(rawUrl || "")); safeUrl = (parsed.hostname + parsed.pathname).slice(0, 160); } catch {}
  stats.samples.push({ reason, title: htmlText(title).slice(0, 100), ...(safeUrl ? { url: safeUrl } : {}) });
}
function extractStructuredCards(html, sourceName, query = "", counters = null) {
  const source = SOURCES[sourceName];
  if (!source || typeof html !== "string") return [];
  const products = [];
  const seenObjects = new Set();
  const isProductObject = value => {
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (types.some(type => String(type || "").toLowerCase() === "product")) return true;
    const title = value.name || value.title || value.displayName || value.productName;
    const url = value.url || value.productUrl || value.canonicalUrl || value.slug || value.urlKey;
    const offers = value.offers || value.offer || {};
    const price = value.price ?? value.salePrice ?? value.finalPrice ?? value.currentPrice ??
      value.specialPrice ?? value.offerPrice ?? offers.price ?? offers.lowPrice;
    return typeof title === "string" && title.trim().length >= 4 &&
      typeof url === "string" && url.trim().length > 0 && price != null;
  };
  const visit = value => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (!Array.isArray(value) && isProductObject(value)) products.push(value);
    if (Array.isArray(value)) value.forEach(visit); else Object.values(value).forEach(visit);
  };
  // Retailers often move product data from JSON-LD into hydration state.
  // Parse JSON-bearing scripts only; never evaluate page JavaScript.
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => /application\/(?:ld\+json|json)/i.test(match[1]) ||
      /(?:__NEXT_DATA__|__NUXT__|INITIAL_STATE|APOLLO_STATE)/i.test(match[1]))
    .map(match => match[2]);
  for (const script of scripts) {
    try { visit(JSON.parse(script.trim())); } catch { /* Ignore non-JSON and malformed hydration payloads. */ }
  }
  const merchant = sourceName === "amazon" ? "Amazon.eg" : sourceName === "jumia" ? "Jumia Egypt" : sourceName === "noon" ? "Noon Egypt" : "Carrefour Egypt";
  const cards = [];
  for (const product of products) {
    const stats = counters?.json;
    if (stats) stats.candidates++;
    const title = htmlText(product.name || product.title || product.displayName || product.productName || "");
    if (title.length < 4 || !INCLUDE.test(title) || EXCLUDE.test(title)) { if (stats) { stats.rejectedName++; addRejectionSample(stats, "name", title, product.url || product.productUrl || product.canonicalUrl || product.slug || product.urlKey); } continue; }
    const offers = product.offers || product.offer || {};
    const rawUrl = product.url || product.productUrl || product.canonicalUrl ||
      product.mainEntityOfPage?.["@id"] || product.slug || product.urlKey || offers.url || "";
    const url = safeProductUrl(rawUrl, sourceName);
    if (!url) { if (stats) { stats.rejectedUrl++; addRejectionSample(stats, "url", title, rawUrl); } continue; }
    const offerList = Array.isArray(offers) ? offers : [offers];
    const foreignCurrencyOffers = offerList.filter(offer => offer && (offer.priceCurrency || offer.currencyCode) && String(offer.priceCurrency || offer.currencyCode).toUpperCase() !== "EGP");
    if (stats && foreignCurrencyOffers.length) stats.currencySignals++;
    const prices = [
      ...offerList.filter(offer => !offer.priceCurrency && !offer.currencyCode ||
        String(offer.priceCurrency || offer.currencyCode).toUpperCase() === "EGP")
        .map(offer => money(offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price)),
      money(product.price?.value ?? product.price?.amount ?? product.price),
      money(product.salePrice?.value ?? product.salePrice),
      money(product.finalPrice?.value ?? product.finalPrice),
      money(product.currentPrice?.value ?? product.currentPrice),
      money(product.specialPrice?.value ?? product.specialPrice),
      money(product.offerPrice?.value ?? product.offerPrice)
    ].filter(value => value !== null);
    const price = prices.length ? Math.min(...prices) : null;
    const oldPrice = money(offers.highPrice || product.highPrice || product.oldPrice || product.listPrice || product.wasPrice);
    if (!price) { if (stats) { if (foreignCurrencyOffers.some(offer => money(offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price) !== null)) stats.rejectedCurrency++; else stats.rejectedPrice++; } continue; }
    const deal = { merchant, title: title.slice(0,180), url, price, old_price: oldPrice > price ? oldPrice : null, discount_pct: oldPrice > price ? Math.round((oldPrice-price)/oldPrice*10000)/100 : 0, category: categoryOf(title), query };
    const validation = validateDeal(deal);
    if (validation.ok) { cards.push(deal); if (stats) stats.accepted++; } else if (stats) stats.rejectedValidation++;
  }
  return cards;
}
function extractCards(html, sourceName, query = "", counters = null) {
  const source = SOURCES[sourceName];
  if (!source || typeof html !== "string") return [];
  let cards = extractStructuredCards(html, sourceName, query, counters);
  const structuredKeys = new Set(cards.map(deal => deal.url + "|" + deal.price));
  let chunks = [];
  if (sourceName === "amazon") {
    // Amazon result cards contain nested divs, so matching a fixed number of
    // closing divs can truncate cards when retailer markup changes. Split at
    // each result-card opening tag so nested title, link, and price remain intact.
    const starts = [...html.matchAll(/<div\b(?=[^>]*\bdata-component-type=["']s-search-result["'])[^>]*>/gi)];
    chunks = starts.map((match, index) => html.slice(match.index, starts[index + 1]?.index ?? html.length));
  }
  else {
    // Retailer card wrappers may be article or div; require a product-like marker.
    const cardPattern = /<(?:article|div)\b(?=[^>]*(?:class|data-qa|data-testid)=["'][^"']*(?:\bprd\b|product(?:[-_ ]?(?:card|item|tile))?|item-product|productContainer)[^"']*["'])[^>]*>/gi;
    const starts = [...html.matchAll(cardPattern)];
    chunks = starts.map((match, index) => html.slice(match.index, starts[index + 1]?.index ?? html.length));
    if (!chunks.length) chunks = [...html.matchAll(/<article[\s\S]*?<\/article>/gi)].map(m => m[0]);
  }
  for (const chunk of chunks) {
    const stats = counters?.html;
    if (stats) stats.candidates++;
    const titleMatch = chunk.match(/<h[23][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/h[23]>/i) ||
      chunk.match(/<(?:h[23]|span|div)[^>]*(?:data-qa|data-testid)=["'][^"']*product[-_ ]?name[^"']*["'][^>]*>([\s\S]*?)<\//i) ||
      chunk.match(/<(?:h[23]|span|div)[^>]*class=["'][^"']*(?:name|title)[^"']*["'][^>]*>([\s\S]*?)<\//i);
    const title = htmlText(titleMatch?.[1] || "");
    if (title.length < 4 || !INCLUDE.test(title) || EXCLUDE.test(title)) { if (stats) { stats.rejectedName++; addRejectionSample(stats, "name", title, ""); } continue; }
    const href = chunk.match(/<a[^>]+href=["']([^"']+)["']/i)?.[1];
    const url = safeProductUrl(href || "", sourceName);
    if (!url) { if (stats) { stats.rejectedUrl++; addRejectionSample(stats, "url", title, href || ""); } continue; }
    const priceMatch = sourceName === "amazon"
      ? (chunk.match(/class=["']a-price-whole["'][^>]*>([\s\S]*?)<\//i) || chunk.match(/class=["']a-offscreen["'][^>]*>([\s\S]*?)<\//i))
      : (chunk.match(/class=["'][^"']*(?:prc|priceNow|price-now|sellingPrice|selling-price|finalPrice|currentPrice|price)["'][^>]*>([\s\S]*?)<\//i) ||
        chunk.match(/(?:data-qa|data-testid)=["'][^"']*product[-_ ]?price[^"']*["'][^>]*>([\s\S]*?)<\//i) ||
        chunk.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i));
    const price = money(htmlText(priceMatch?.[1] || ""));
    if (stats && /\b(?:USD|SAR|AED|EUR|GBP)\b|دولار|ريال|درهم|يورو|استرليني/i.test(chunk)) stats.currencySignals++;
    const oldMatch = chunk.match(/class=["'][^"']*(?:old|oldPrice|price-was)[^"']*["'][^>]*>([\s\S]*?)<\//i);
    const oldPrice = money(htmlText(oldMatch?.[1] || ""));
    if (!price) { if (stats) stats.rejectedPrice++; continue; }
    const deal = { merchant: sourceName === "amazon" ? "Amazon.eg" : sourceName === "jumia" ? "Jumia Egypt" : sourceName === "carrefour" ? "Carrefour Egypt" : "Noon Egypt", title: title.slice(0,180), url, price, old_price: oldPrice > price ? oldPrice : null, discount_pct: oldPrice > price ? Math.round((oldPrice-price)/oldPrice*10000)/100 : 0, category: categoryOf(title), query };
    const validation = validateDeal(deal);
    if (validation.ok) { if (stats) stats.accepted++; const key = deal.url + "|" + deal.price; if (!structuredKeys.has(key)) cards.push(deal); structuredKeys.add(key); }
    else if (stats) stats.rejectedValidation++;
  }
  return cards;
}
function createExtractionCounters() {
  const stage = () => ({ candidates: 0, rejectedName: 0, rejectedUrl: 0, rejectedPrice: 0, rejectedCurrency: 0, rejectedValidation: 0, currencySignals: 0, accepted: 0, samples: [] });
  return { json: stage(), html: stage() };
}
function extractionDiagnostics(html, sourceName, deals = [], counters = null) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => /application\/(?:ld\+json|json)/i.test(match[1]) ||
      /(?:__NEXT_DATA__|__NUXT__|INITIAL_STATE|APOLLO_STATE)/i.test(match[1]));
  let jsonParsed = 0, structuredProductObjects = 0, jsonParseFailures = 0;
  const productObjectShapes = [];
  const seen = new Set();
  const describeFields = value => Object.fromEntries(
    Object.keys(value || {}).sort().slice(0, 40).map(key => {
      const field = value[key];
      return [key, Array.isArray(field) ? "array" : field === null ? "null" : typeof field];
    })
  );
  const visit = value => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (!Array.isArray(value) && types.some(type => String(type || "").toLowerCase() === "product")) {
      structuredProductObjects++;
      if (productObjectShapes.length < 10) {
        const nested = {};
        for (const key of ["offers", "offer", "price", "salePrice", "finalPrice", "currentPrice", "specialPrice", "offerPrice"]) {
          const field = value[key];
          if (field && typeof field === "object" && !Array.isArray(field)) nested[key] = describeFields(field);
          else if (field !== undefined) nested[key] = Array.isArray(field) ? "array" : field === null ? "null" : typeof field;
        }
        productObjectShapes.push({ fields: describeFields(value), nested });
      }
    }
    if (Array.isArray(value)) value.forEach(visit); else Object.values(value).forEach(visit);
  };
  for (const script of scripts) {
    try { visit(JSON.parse(script[2].trim())); jsonParsed++; }
    catch { jsonParseFailures++; }
  }
  let htmlCardChunks = 0, htmlTitleMatches = 0;
  if (sourceName === "amazon") {
    htmlCardChunks = [...html.matchAll(/<div\b(?=[^>]*\bdata-component-type=["']s-search-result["'])[^>]*>/gi)].length;
  } else {
    const cardPattern = /<(?:article|div)\b(?=[^>]*(?:class|data-qa|data-testid)=["'][^"']*(?:\bprd\b|product(?:[-_ ]?(?:card|item|tile))?|item-product|productContainer)[^"']*["'])[^>]*>/gi;
    htmlCardChunks = [...html.matchAll(cardPattern)].length;
    if (!htmlCardChunks) htmlCardChunks = [...html.matchAll(/<article[\s\S]*?<\/article>/gi)].length;
  }
  const titlePattern = /<(?:h[23]|span|div)[^>]*(?:class|data-qa|data-testid)=["'][^"']*(?:name|title|product[-_ ]?name)[^"']*["'][^>]*>/gi;
  htmlTitleMatches = [...html.matchAll(titlePattern)].length;
  return {
    structuredScriptsFound: scripts.length,
    structuredJsonParsed: jsonParsed,
    structuredJsonParseFailures: jsonParseFailures,
    structuredProductObjects,
    productObjectShapes,
    htmlCardChunks,
    htmlTitleMatches,
    validatedDeals: deals.length,
    stages: counters ? { json: { ...counters.json }, html: { ...counters.html } } : undefined
  };
}
function getScraperKeys() {
  return [...new Set([
    String(process.env.SCRAPER_API_KEY || "").trim(),
    String(process.env.SCRAPER_API_KEY_2 || "").trim()
  ].filter(Boolean))];
}
async function fetchSearch(sourceName, query, { timeoutMs = 70000, fetchImpl = globalThis.fetch } = {}) {
  const source = SOURCES[sourceName];
  if (!source) throw new Error("unsupported_deal_source");
  const keys = getScraperKeys();
  if (!keys.length) return { source: sourceName, ok: false, reason: "SCRAPER_API_KEY_not_configured", deals: [] };
  const startIndex = nextScraperKeyIndex % keys.length;
  nextScraperKeyIndex = (nextScraperKeyIndex + 1) % keys.length;
  const targetUrl = sourceName === "carrefour" ? source.base : `${source.base}${encodeURIComponent(query)}`;
  const requestWithKey = async key => {
    const endpoint = new URL("https://api.scraperapi.com/");
    endpoint.searchParams.set("api_key", key);
    endpoint.searchParams.set("url", targetUrl);
    endpoint.searchParams.set("country_code", "eg");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, { signal: controller.signal, redirect: "error" });
      if (!response.ok) return { source: sourceName, ok: false, status: response.status, reason: `http_${response.status}`, deals: [] };
      const html = await response.text();
      const counters = createExtractionCounters();
      const deals = extractCards(html, sourceName, query, counters);
      const diagnostics = extractionDiagnostics(html, sourceName, deals, counters);
      const pageSignal = /captcha|robot check|automated access|validatecaptcha|enter the characters you see/i.test(html)
        ? "captcha_or_block_page"
        : /data-component-type=["']s-search-result["']|application\/(?:ld\+json|json)|__NEXT_DATA__|__NUXT__|data-qa=["'][^"']*product|data-testid=["'][^"']*product|class=["'][^"']*(?:prd|product-card|productCard|product-item)/i.test(html)
          ? "product_markup_present"
          : html.trim().length === 0 ? "empty_response" : "no_product_markers";
      return { source: sourceName, ok: true, deals, pageSignal, extractionDiagnostics: diagnostics };
    } catch (error) { return { source: sourceName, ok: false, reason: error.name === "AbortError" ? "timeout" : "fetch_failed", error: redactString(error?.message || "fetch_failed"), deals: [] }; }
    finally { clearTimeout(timer); }
  };
  const first = await requestWithKey(keys[startIndex]);
  // Retry once with the alternate key for auth failures or transient server errors.
  // Never retry rate limits, timeouts, or successful pages with empty extraction.
  const retryableStatus = [401, 403, 500, 502, 503, 504].includes(first.status);
  if (!first.ok && retryableStatus && keys.length > 1) {
    const alternate = await requestWithKey(keys[(startIndex + 1) % keys.length]);
    if (alternate.ok) return alternate;
    return { ...alternate, reason: `${first.reason};alternate_${alternate.reason}` };
  }
  const { status, ...result } = first;
  return result;
}
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try { results[index] = { status: "fulfilled", value: await worker(items[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results;
}
async function collectDealCandidates({ amazonQueries = ["مسحوق غسيل منظف", "مناديل ورقية", "شامبو صابون كريم"], otherQueries = ["مسحوق غسيل منظف", "مناديل ورقية", "شامبو صابون كريم"], edition = "all", fetchImpl, snapFlyerFetcher = collectSnapFlyerCatalogDeals, snapFlyerOptions = {} } = {}) {
  const tasks = [];
  // Each newsletter queries only the stores it can publish. This avoids
  // paying for Amazon results during the other-store edition and vice versa.
  if (edition === "all" || edition === "amazon") {
    amazonQueries.forEach((q, queryIndex) => tasks.push({ source: "amazon", query: q, queryIndex }));
  }
  if (edition === "all" || edition === "other_sites") {
    otherQueries.forEach((q, queryIndex) => { for (const source of ["jumia", "noon"]) tasks.push({ source, query: q, queryIndex }); });
    tasks.push({ source: "carrefour", query: "", queryIndex: 0 });
  }
  if (!["all", "amazon", "other_sites"].includes(edition)) throw new Error("unsupported_newsletter_edition");
  const results = await mapWithConcurrency(tasks, MAX_CONCURRENT_SCRAPER_REQUESTS, task => fetchSearch(task.source, task.query, { fetchImpl }));
  const deals = [], errors = [], sourceStats = [];
  let snapFlyerSourceCount = 0;
  const storeCounters = new Map();
  const seen = new Set();
  for (let index = 0; index < results.length; index++) {
    const r = results[index];
    const task = tasks[index];
    if (!storeCounters.has(task.source)) storeCounters.set(task.source, { source: task.source, queries: 0, transportFailures: 0, json: createExtractionCounters().json, html: createExtractionCounters().html });
    const aggregate = storeCounters.get(task.source);
    aggregate.queries++;
    if (r.status !== "fulfilled") {
      aggregate.transportFailures++;
      errors.push({ source: task.source, reason: "task_rejected" });
      sourceStats.push({ source: task.source, queryIndex: task.queryIndex, ok: false, stage: "transport", extractedCount: 0, reason: "task_rejected" });
      continue;
    }
    if (!r.value.ok) {
      aggregate.transportFailures++;
      errors.push({ source: r.value.source, reason: r.value.reason });
      sourceStats.push({ source: r.value.source, queryIndex: task.queryIndex, ok: false, stage: "transport", extractedCount: 0, reason: r.value.reason });
      continue;
    }
    const extractedCount = r.value.deals.length;
    const stages = r.value.extractionDiagnostics?.stages || null;
    const stage = extractedCount > 0 ? "validated" : stages && (stages.json.candidates + stages.html.candidates) > 0 ? "candidate_rejection" : "extraction_empty";
    sourceStats.push({ source: r.value.source, queryIndex: task.queryIndex, ok: true, stage, extractedCount, ...(r.value.pageSignal ? { pageSignal: r.value.pageSignal } : {}), ...(r.value.extractionDiagnostics ? { extractionDiagnostics: r.value.extractionDiagnostics } : {}) });
    if (stages) for (const format of ["json", "html"]) for (const key of Object.keys(aggregate[format])) {
      if (key === "samples") {
        for (const sample of stages[format].samples || []) if (aggregate[format].samples.length < 8) aggregate[format].samples.push(sample);
      } else aggregate[format][key] += Number(stages[format][key] || 0);
    }
    // A successful HTTP response with no parsed products is diagnostically
    // different from a source that failed to load. Record it without logging HTML.
    if (extractedCount === 0) errors.push({ source: r.value.source, reason: "no_products_extracted", ...(r.value.pageSignal ? { pageSignal: r.value.pageSignal } : {}) });
    for (const d of r.value.deals) {
      const key = `${d.url}|${d.title}|${d.price}`;
      if (!seen.has(key)) { seen.add(key); deals.push(d); }
    }
  }
  if (edition === "other_sites" || edition === "all") {
    try {
      const catalogResult = await snapFlyerFetcher(snapFlyerOptions);
      snapFlyerSourceCount = Number.isInteger(catalogResult.sourceCount) && catalogResult.sourceCount > 0 ? catalogResult.sourceCount : 0;
      for (const deal of catalogResult.deals || []) {
        const key = String(deal.url) + "|" + String(deal.title) + "|" + String(deal.price);
        if (!seen.has(key)) { seen.add(key); deals.push(deal); }
      }
      errors.push(...(catalogResult.errors || []));
      sourceStats.push(...(catalogResult.sourceStats || []));
      for (const stat of catalogResult.sourceStats || []) {
        if (!storeCounters.has(stat.source)) storeCounters.set(stat.source, {
          source: stat.source, queries: 1, transportFailures: stat.ok ? 0 : 1,
          json: createExtractionCounters().json, html: createExtractionCounters().html
        });
      }
    } catch (error) {
      errors.push({ source: "snapflyer_catalogs", reason: String(error?.message || "fetch_failed").slice(0, 120) });
      sourceStats.push({ source: "snapflyer_catalogs", ok: false, stage: "transport", extractedCount: 0, reason: "fetch_failed" });
    }
  }
  for (const task of tasks) if (!storeCounters.has(task.source)) storeCounters.set(task.source, { source: task.source, queries: 0, transportFailures: 0, json: createExtractionCounters().json, html: createExtractionCounters().html });
  return { deals, errors, sourceStats, sourceSummary: [...storeCounters.values()], sourceCount: tasks.length + snapFlyerSourceCount };
}
module.exports = { SOURCES, categoryOf, safeProductUrl, extractCards, extractionDiagnostics, createExtractionCounters, getScraperKeys, fetchSearch, collectDealCandidates };
