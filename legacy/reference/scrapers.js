"use strict";

/**
 * سحب عروض المنظفات والورقيات ومستحضرات التجميل.
 * أمازون مصر أولاً، ثم جوميا ونون. المفتاح: SCRAPER_API_KEY.
 */

const axios = require("axios");
const cheerio = require("cheerio");

const TITLE_OK =
  /غسيل|مسحوق|بودر|جل|منعم|كلور|صابون|شامبو|كريم|مناديل|حفاض|فاين|ديتول|فيري|بريل|برسيل|تايد|اريال|آريال|اومو|أومو|كلوركس|هاريك|هاربيك|دوف|لوكس|بانتين|بامبرز|مولفكس|محارم|غسول|مرطب|اتوماتيك|عناية|ورقي|مكياج|تجميل|لوشن|سيروم|واقي شمس|مزيل عرق|معجون|كحل|تونر|احمر شفاه|أحمر شفاه|ماسكارا|فازلين|نيفيا|غمبل|كولجيت/i;

const TITLE_SKIP =
  /tv|لابتوب|موبايل|تليفون|ساعة ذكية|سماعات|ملابس|حذاء|عطر فاخر|مكيف|ثلاجة|غسالة ملابس كهرب|تلفزيون|ايفون|سامسونج جالكسي/i;

function apiKey() {
  return String(process.env.SCRAPER_API_KEY || "").trim();
}

async function loadPage(url, render = false) {
  const key = apiKey();
  if (!key) {
    console.warn("SCRAPER_API_KEY غير مضبوط — تخطي السحب المباشر");
    return null;
  }
  try {
    const res = await axios.get("http://api.scraperapi.com", {
      params: {
        api_key: key,
        url,
        render: render ? "true" : "false",
        country_code: "eg",
      },
      timeout: render ? 45_000 : 28_000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (!res.data || typeof res.data !== "string") return null;
    return cheerio.load(res.data);
  } catch (e) {
    console.error(`loadPage [${url}]:`, e.message);
    return null;
  }
}

function toNumber(raw) {
  const s = String(raw || "")
    .replace(/[٠-٩]/g, (ch) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(ch)])
    .replace(/,/g, "");
  const m = s.match(/(\d+(?:\.\d+)?)/);
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n >= 8 && n <= 200000 ? n : 0;
}

function absUrl(href, base) {
  if (!href) return "";
  if (href.startsWith("http")) return href.split("?")[0];
  try {
    return new URL(href, base).href.split("?")[0];
  } catch {
    return "";
  }
}

function keepTitle(title) {
  if (!title || title.length < 4) return false;
  if (TITLE_SKIP.test(title)) return false;
  return TITLE_OK.test(title);
}

function classify(title, hinted) {
  if (hinted && ["detergent", "paper", "care"].includes(hinted)) return hinted;
  const t = String(title || "");
  if (/حفاض|بامبرز|مولفكس|مناديل|فاين|محارم|كلينكس|ورقي|فيبي/i.test(t)) return "paper";
  if (
    /صابون|شامبو|كريم|غسول|مرطب|دوف|لوكس|بانتين|هيد.?اند|عناية|مكياج|تجميل|لوشن|سيروم|واقي شمس|مزيل عرق|معجون|كحل|تونر|ماسكارا|احمر|أحمر|فازلين|نيفيا/i.test(
      t
    )
  ) {
    return "care";
  }
  return "detergent";
}

async function scrapeAmazon(query, hinted) {
  const url = `https://www.amazon.eg/s?k=${encodeURIComponent(query)}&language=ar_AE`;
  let $ = await loadPage(url, false);
  let deals = parseAmazon($, hinted);
  if (deals.length < 3) {
    $ = await loadPage(url, true);
    const extra = parseAmazon($, hinted);
    if (extra.length > deals.length) deals = extra;
  }
  return deals;
}

function parseAmazon($, hinted) {
  if (!$) return [];
  const deals = [];
  const seen = new Set();
  $('[data-component-type="s-search-result"], div.s-result-item[data-asin]').each((_i, el) => {
    const node = $(el);
    const asin = String(node.attr("data-asin") || "").trim();
    const title = node.find("h2 a span, h2 span").first().text().trim();
    if (!keepTitle(title)) return;
    const hrefRaw = node.find("h2 a").attr("href") || (asin ? `/dp/${asin}` : "");
    const link = absUrl(hrefRaw, "https://www.amazon.eg");
    const offs = node
      .find(".a-price .a-offscreen, .a-offscreen")
      .map((_j, e) => toNumber($(e).text()))
      .get()
      .filter(Boolean);
    const price = offs[0] || toNumber(node.find(".a-price-whole").first().text());
    const old_price = offs[1] && offs[1] > price ? offs[1] : null;
    if (!price || !link) return;
    const key = asin || `${title.slice(0, 24)}|${price}`;
    if (seen.has(key)) return;
    seen.add(key);
    deals.push({
      title: title.slice(0, 110),
      price,
      old_price,
      link,
      source: "أمازون",
      category: classify(title, hinted),
    });
  });
  return deals.slice(0, 24);
}

async function scrapeJumia(query, hinted) {
  const url = `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(query)}`;
  const $ = await loadPage(url, false);
  if (!$) return [];
  const deals = [];
  $("article.prd, .prd._fb").each((_i, el) => {
    const title = $(el).find(".name, h3.name").first().text().trim();
    if (!keepTitle(title)) return;
    const price = toNumber($(el).find(".prc").first().text());
    const old_price = toNumber($(el).find(".old").first().text()) || null;
    let href = $(el).find("a").attr("href");
    if (!title || !price || !href) return;
    const link = absUrl(href, "https://www.jumia.com.eg");
    deals.push({
      title: title.slice(0, 110),
      price,
      old_price: old_price > price ? old_price : null,
      link,
      source: "جوميا",
      category: classify(title, hinted),
    });
  });
  return deals.slice(0, 16);
}

async function scrapeNoon(query, hinted) {
  const url = `https://www.noon.com/egypt-ar/search/?q=${encodeURIComponent(query)}`;
  const $ = await loadPage(url, false);
  if (!$) return [];
  const deals = [];
  $('[data-qa="product-name"], article, .productContainer').each((_i, el) => {
    const title = $(el).find('[data-qa="product-name"], .productTitle').first().text().trim();
    if (!keepTitle(title)) return;
    const price = toNumber($(el).find('[data-qa="product-price"], .priceNow, .price').first().text());
    const old_price = toNumber($(el).find(".oldPrice, [data-qa='product-price-was']").first().text()) || null;
    let href = $(el).find("a").attr("href");
    if (!title || !price || !href) return;
    deals.push({
      title: title.slice(0, 110),
      price,
      old_price: old_price > price ? old_price : null,
      link: absUrl(href, "https://www.noon.com"),
      source: "نون",
      category: classify(title, hinted),
    });
  });
  return deals.slice(0, 16);
}

const CATEGORY_QUERIES = [
  { q: "مسحوق غسيل اتوماتيك جل غسيل", cat: "detergent" },
  { q: "مناديل فاين حفاضات", cat: "paper" },
  { q: "صابون شامبو كريم مكياج", cat: "care" },
];

async function fetchDealsFromSite() {
  const jobs = CATEGORY_QUERIES.flatMap(({ q, cat }) => [
    scrapeAmazon(q, cat),
    scrapeJumia(q, cat),
    scrapeNoon(q, cat),
  ]);
  const settled = await Promise.allSettled(jobs);
  const all = [];
  const seen = new Set();
  for (const r of settled) {
    if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
    for (const it of r.value) {
      const key = `${String(it.link || it.title).slice(0, 80)}|${it.price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(it);
    }
  }
  all.sort((a, b) => {
    const da = a.old_price && a.old_price > a.price ? a.old_price - a.price : 0;
    const db = b.old_price && b.old_price > b.price ? b.old_price - b.price : 0;
    if (db !== da) return db - da;
    const amazon = (x) => (x.source === "أمازون" ? 0 : 1);
    if (amazon(a) !== amazon(b)) return amazon(a) - amazon(b);
    return a.price - b.price;
  });
  return all;
}

function isDiscounted(it, minPct = 18) {
  if (!it?.old_price || it.old_price <= it.price) return false;
  return (it.old_price - it.price) / it.old_price >= minPct / 100;
}

async function fetchLowAmazonDeals() {
  const all = await fetchDealsFromSite();
  return all.filter((it) => it.source === "أمازون" && isDiscounted(it, 15));
}

module.exports = {
  loadPage,
  scrapeAmazon,
  scrapeJumia,
  scrapeNoon,
  fetchDealsFromSite,
  fetchLowAmazonDeals,
  isDiscounted,
  classify,
};
