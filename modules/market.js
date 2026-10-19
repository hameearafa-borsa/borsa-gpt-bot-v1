"use strict";

const { redactString } = require("../core/diagnostics");

async function getJson(url, timeoutMs = 8000) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "borsa-gpt-bot/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

async function fetchUsdEgp() {
  try {
    const data = await getJson("https://open.er-api.com/v6/latest/USD");
    const rate = Number(data?.rates?.EGP);
    if (rate > 0) return rate;
  } catch (err) { console.warn("[MARKET_USD]", redactString(err.message)); }
  try {
    const data = await getJson("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json");
    const rate = Number(data?.usd?.egp);
    return rate > 0 ? rate : null;
  } catch (err) {
    console.warn("[MARKET_USD_FALLBACK]", redactString(err.message));
    return null;
  }
}

async function fetchGoldUsd() {
  try {
    const data = await getJson("https://api.gold-api.com/price/XAU");
    const price = Number(data?.price);
    return price > 0 ? price : null;
  } catch (err) {
    console.warn("[MARKET_GOLD]", redactString(err.message));
    return null;
  }
}

async function fetchBrentUsd() {
  for (const host of ["query1", "query2"]) {
    try {
      const data = await getJson(`https://${host}.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=1d`);
      const price = Number(data?.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (price > 0) return price;
    } catch (err) { console.warn("[MARKET_BRENT]", host, redactString(err.message)); }
  }
  return null;
}

function money(value, digits = 2) {
  return value == null ? "غير متاح" : Number(value).toFixed(digits);
}

async function fetchMarketPrices() {
  const [usdEgp, goldOunceUsd, brentUsd] = await Promise.all([fetchUsdEgp(), fetchGoldUsd(), fetchBrentUsd()]);
  let gold21 = null;
  let sovereign = null;
  if (goldOunceUsd && usdEgp) {
    const gold24Gram = (goldOunceUsd / 31.1034768) * usdEgp;
    gold21 = gold24Gram * (21 / 24);
    sovereign = gold21 * 8;
  }
  return { usdEgp, brentUsd, gold21, sovereign };
}

async function reportText() {
  const prices = await fetchMarketPrices();
  const available = [prices.usdEgp, prices.brentUsd, prices.gold21].some((value) => value != null);
  if (!available) return "💵 نشرة السوق\nتعذر الوصول إلى مصادر الدولار والذهب والنفط الآن. لم يتم اختراع أي سعر.";
  return [
    "💵 نشرة السوق — بورصة المنظفات",
    `الدولار مقابل الجنيه: ${money(prices.usdEgp)} ج.م`,
    `خام برنت: ${prices.brentUsd == null ? "غير متاح" : `$${money(prices.brentUsd)}`}`,
    `جرام الذهب عيار 21: ${prices.gold21 == null ? "غير متاح" : `${Math.round(prices.gold21)} ج.م (تقريب عالمي)`}`,
    `الجنيه الذهب: ${prices.sovereign == null ? "غير متاح" : `${Math.round(prices.sovereign)} ج.م (تقريب عالمي)`}`,
    "",
    "الأرقام من مصادر عامة لحظية وقد تتأخر عن سوق الصاغة المحلي.",
  ].join("\n");
}

module.exports = { fetchUsdEgp, fetchGoldUsd, fetchBrentUsd, fetchMarketPrices, reportText };
