"use strict";

const https = require("node:https");
const { encodeQuery } = require("../core/links");

function buildWeatherSearch(city = "القاهرة") {
  const q = `طقس ${String(city || "القاهرة").trim().slice(0, 80)}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function getJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:") return reject(new Error("weather_https_required"));
    const req = https.get(u, { headers: { "user-agent": "Borsa-GPT-Bot/1.0", accept: "application/json" }, timeout: timeoutMs }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(new Error("weather_response_too_large")); });
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { return reject(new Error(`weather_invalid_json_http_${res.statusCode}`)); }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`weather_http_${res.statusCode}`));
        resolve(parsed);
      });
    });
    req.on("timeout", () => req.destroy(new Error("weather_timeout")));
    req.on("error", reject);
  });
}

const WEATHER_CODES_AR = {
  0: "سماء صافية", 1: "صحو غالبًا", 2: "غائم جزئيًا", 3: "غائم",
  45: "شبورة", 48: "شبورة متجمدة", 51: "رذاذ خفيف", 53: "رذاذ متوسط", 55: "رذاذ كثيف",
  61: "مطر خفيف", 63: "مطر متوسط", 65: "مطر غزير", 71: "ثلج خفيف", 73: "ثلج متوسط", 75: "ثلج غزير", 77: "حبيبات ثلجية",
  80: "زخات مطر خفيفة", 81: "زخات مطر متوسطة", 82: "زخات مطر قوية", 85: "زخات ثلج خفيفة", 86: "زخات ثلج غزيرة", 95: "عواصف رعدية", 96: "عواصف رعدية مع برد", 99: "عواصف رعدية قوية مع برد"
};

// Fixed Egyptian coordinates avoid geocoding a same-named city outside Egypt.
const EGYPT_CITIES = Object.freeze([
  { name: "الإسكندرية", latitude: 31.2001, longitude: 29.9187 },
  { name: "القاهرة", latitude: 30.0444, longitude: 31.2357 },
  { name: "المنيا", latitude: 28.0871, longitude: 30.7618 },
  { name: "الأقصر", latitude: 25.6872, longitude: 32.6396 }
]);

function validateCurrentWeather(forecast, cityName) {
  const c = forecast?.current;
  const numeric = ["temperature_2m", "relative_humidity_2m", "apparent_temperature", "wind_speed_10m", "precipitation", "weather_code"];
  if (!c || numeric.some(key => !Number.isFinite(c[key])) ||
      c.relative_humidity_2m < 0 || c.relative_humidity_2m > 100 ||
      c.wind_speed_10m < 0 || c.precipitation < 0 ||
      !Object.hasOwn(WEATHER_CODES_AR, c.weather_code) ||
      typeof c.time !== "string" || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$/.test(c.time) ||
      forecast.timezone !== "Africa/Cairo") {
    throw new Error(`weather_invalid_or_incomplete_data_${cityName}`);
  }
  return {
    city: cityName,
    temperature: c.temperature_2m,
    feelsLike: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    wind: c.wind_speed_10m,
    precipitation: c.precipitation,
    condition: WEATHER_CODES_AR[c.weather_code],
    time: c.time,
    timezone: forecast.timezone,
    source: "Open-Meteo"
  };
}

async function getLiveWeatherAtCoordinates(city, { fetchJson = getJson } = {}) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(city.latitude)}&longitude=${encodeURIComponent(city.longitude)}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=Africa%2FCairo`;
  const forecast = await fetchJson(url);
  return validateCurrentWeather(forecast, city.name);
}

async function getDailyWeatherReport({ fetchJson = getJson, now = new Date() } = {}) {
  // Do not return or format a partial report: Promise.all rejects if any city fails.
  const weather = await Promise.all(EGYPT_CITIES.map(city => getLiveWeatherAtCoordinates(city, { fetchJson })));
  const stamp = new Intl.DateTimeFormat("ar-EG", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(now);
  const lines = [
    "🌦️ نشرة الطقس الحية — بورصة المنظفات",
    `🕒 تحديث النشرة: ${stamp} بتوقيت القاهرة`,
    ""
  ];
  for (const w of weather) {
    lines.push(
      `📍 ${w.city}`,
      `• الحالة: ${w.condition}`,
      `• الحرارة: ${w.temperature}°م (المحسوسة ${w.feelsLike}°م)`,
      `• الرطوبة: ${w.humidity}%`,
      `• الرياح: ${w.wind} كم/س`,
      `• الهطول: ${w.precipitation} مم`,
      ""
    );
  }
  lines.push("المصدر: Open-Meteo");
  return { message: lines.join("\n").trim(), cities: weather, measuredAt: weather.map(w => w.time).sort().at(-1) };
}

async function getLiveWeather(city = "القاهرة", { fetchJson = getJson } = {}) {
  const cleanCity = String(city || "القاهرة").trim().slice(0, 80);
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanCity)}&count=1&language=ar&format=json`;
  const geo = await fetchJson(geoUrl);
  const place = geo.results?.[0];
  if (!place || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) throw new Error("weather_city_not_found");
  const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(place.latitude)}&longitude=${encodeURIComponent(place.longitude)}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m&timezone=Africa%2FCairo`;
  const forecast = await fetchJson(forecastUrl);
  const current = forecast.current;
  if (!current || !Number.isFinite(current.temperature_2m)) throw new Error("weather_current_data_unavailable");
  return {
    city: [place.name, place.admin1, place.country].filter(Boolean).join("، "),
    temperature: current.temperature_2m,
    feelsLike: Number.isFinite(current.apparent_temperature) ? current.apparent_temperature : null,
    humidity: Number.isFinite(current.relative_humidity_2m) ? current.relative_humidity_2m : null,
    wind: Number.isFinite(current.wind_speed_10m) ? current.wind_speed_10m : null,
    precipitation: Number.isFinite(current.precipitation) ? current.precipitation : null,
    condition: WEATHER_CODES_AR[current.weather_code] || "حالة جوية غير محددة",
    time: current.time || null,
    timezone: forecast.timezone || "Africa/Cairo",
    source: "Open-Meteo"
  };
}

async function getWeatherSummary(_ai, city = "القاهرة", options = {}) {
  const searchUrl = buildWeatherSearch(city);
  try {
    const w = await getLiveWeather(city, options);
    const details = [
      `🌦️ الطقس الحالي في ${w.city}`,
      `الحالة: ${w.condition}`,
      `الحرارة: ${w.temperature}°م${w.feelsLike == null ? "" : `, المحسوسة ${w.feelsLike}°م`}`,
      w.humidity == null ? null : `الرطوبة: ${w.humidity}%`,
      w.wind == null ? null : `سرعة الرياح: ${w.wind} كم/س`,
      w.precipitation == null ? null : `الهطول: ${w.precipitation} مم`,
      w.time ? `وقت القياس المحلي: ${w.time.replace("T", " ")} (${w.timezone})` : null,
      `المصدر: ${w.source}`
    ].filter(Boolean);
    return { ok: true, city: w.city, weather: w, searchUrl, message: details.join("\n") };
  } catch (error) {
    return { ok: false, city, searchUrl, message: "تعذر جلب بيانات الطقس الحية الآن؛ لن أخمّن درجة الحرارة. يمكنك المحاولة لاحقًا.", error: String(error?.message || "weather_error").slice(0, 120) };
  }
}
module.exports = { buildWeatherSearch, getWeatherSummary, getLiveWeather, getLiveWeatherAtCoordinates, getDailyWeatherReport, EGYPT_CITIES, WEATHER_CODES_AR };
