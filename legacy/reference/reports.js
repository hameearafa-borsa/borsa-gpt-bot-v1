"use strict";

const axios = require("axios");

const WEATHER_CITIES = [
  { name: "الإسكندرية", lat: 31.2001, lon: 29.9187 },
  { name: "القاهرة", lat: 30.0444, lon: 31.2357 },
  { name: "المنيا", lat: 28.0871, lon: 30.7618 },
  { name: "الأقصر", lat: 25.6872, lon: 32.6396 },
];

const HTTP = { timeout: 8000, validateStatus: (s) => s >= 200 && s < 500 };

async function fetchUsdEgp() {
  try {
    const usdRes = await axios.get("https://open.er-api.com/v6/latest/USD", HTTP);
    if (usdRes.data?.rates?.EGP) return Number(usdRes.data.rates.EGP);
  } catch (e) {
    console.warn("er-api", e.message);
  }
  try {
    const res = await axios.get(
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
      HTTP
    );
    return Number(res.data?.usd?.egp) || 0;
  } catch (e) {
    console.warn("currency-api", e.message);
    return 0;
  }
}

async function fetchGoldUsd() {
  try {
    const goldRes = await axios.get("https://api.gold-api.com/price/XAU", HTTP);
    return Number(goldRes.data?.price) || 0;
  } catch (e) {
    console.warn("gold-api", e.message);
    return 0;
  }
}

async function fetchBrentUsd() {
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; BorsaBot/2.3)" };
  for (const host of ["query1", "query2"]) {
    try {
      const res = await axios.get(
        `https://${host}.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=1d`,
        { headers, timeout: 8000, validateStatus: (s) => s >= 200 && s < 500 }
      );
      const price = res.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) return Number(price);
    } catch (e) {
      console.warn("yahoo", host, e.message);
    }
  }
  return 0;
}

async function fetchMarketPrices() {
  const [usdEgp, goldOunceUsd, brentUsd] = await Promise.all([
    fetchUsdEgp(),
    fetchGoldUsd(),
    fetchBrentUsd(),
  ]);
  let gold21Egp = 0;
  let goldSovereignEgp = 0;
  if (goldOunceUsd > 0 && usdEgp > 0) {
    const gold24EgpGram = (goldOunceUsd / 31.1034768) * usdEgp;
    gold21Egp = gold24EgpGram * (21 / 24);
    goldSovereignEgp = gold21Egp * 8;
  }
  return {
    usdEgp: usdEgp ? usdEgp.toFixed(2) : "غير متاح",
    brent: brentUsd ? brentUsd.toFixed(2) : "غير متاح",
    gold21: gold21Egp ? Math.round(gold21Egp) : "غير متاح",
    goldSovereign: goldSovereignEgp ? Math.round(goldSovereignEgp) : "غير متاح",
  };
}

async function generateMarketReport() {
  const prices = await fetchMarketPrices();
  if (!prices) return null;
  const available = [prices.usdEgp, prices.brent, prices.gold21].filter((v) => v && v !== "غير متاح");
  if (!available.length) return null;
  return (
    `<b>نشرة الأسعار الاقتصادية اليومية – بورصة المنظفات</b>\n\n` +
    `سعر الدولار مقابل الجنيه: ${prices.usdEgp} ج.م\n` +
    `سعر برميل خام برنت: $${prices.brent}\n` +
    `جرام الذهب عيار 21: ${prices.gold21} ج.م (تقريبي العالمية)\n` +
    `سعر الجنيه الذهب: ${prices.goldSovereign} ج.م (تقريبي)\n\n` +
    `نتمنى لكم يوماً موفقاً وتجارة رابحة.`
  );
}

async function generateWeatherReport(escHtml) {
  const requests = WEATHER_CITIES.map((city) => {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
      `&current_weather=true&timezone=Africa/Cairo`;
    return axios
      .get(url, { timeout: 8000 })
      .then((res) => ({ city, data: res.data }))
      .catch(() => ({ city, data: null }));
  });
  const results = await Promise.all(requests);
  const ok = results.filter((r) => r.data?.current_weather).length;
  if (!ok) return null;
  let report = `<b>نشرة الطقس اليومية – بورصة المنظفات</b>\n\n`;
  for (const { city, data } of results) {
    if (data?.current_weather) {
      const temp = Math.round(data.current_weather.temperature);
      const wind = Math.round(data.current_weather.windspeed);
      report += `${escHtml(city.name)}:\n• الحرارة: ${temp}°م\n• سرعة الرياح: ${wind} كم/س\n\n`;
    } else {
      report += `${escHtml(city.name)}: غير متاح حالياً\n\n`;
    }
  }
  report += "نتمنى لكم يوماً موفقاً وتجارة رابحة.";
  return report;
}

module.exports = {
  fetchMarketPrices,
  generateMarketReport,
  generateWeatherReport,
};
