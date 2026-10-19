"use strict";

const { normalizeArabic } = require("../core/normalization");
const { redactString } = require("../core/diagnostics");

const KNOWN_CITIES = [
  { name: "القاهرة", keys: ["القاهره", "cairo"], lat: 30.0444, lon: 31.2357 },
  { name: "الجيزة", keys: ["الجيزه", "giza"], lat: 30.0131, lon: 31.2089 },
  { name: "الإسكندرية", keys: ["الاسكندريه", "alexandria"], lat: 31.2001, lon: 29.9187 },
  { name: "المنيا", keys: ["minya"], lat: 28.1099, lon: 30.7503 },
  { name: "أسيوط", keys: ["اسيوط", "asyut"], lat: 27.1809, lon: 31.1837 },
  { name: "الأقصر", keys: ["الاقصر", "luxor"], lat: 25.6872, lon: 32.6396 },
  { name: "أسوان", keys: ["اسوان", "aswan"], lat: 24.0889, lon: 32.8998 },
  { name: "طنطا", keys: ["tanta"], lat: 30.7865, lon: 31.0004 },
  { name: "المنصورة", keys: ["المنصوره", "mansoura"], lat: 31.0409, lon: 31.3785 },
  { name: "بورسعيد", keys: ["port said"], lat: 31.2653, lon: 32.3019 },
  { name: "السويس", keys: ["suez"], lat: 29.9668, lon: 32.5498 },
  { name: "دمياط", keys: ["damietta"], lat: 31.4175, lon: 31.8144 },
];

const WMO = {
  0: "صافٍ", 1: "صافٍ غالبًا", 2: "غائم جزئيًا", 3: "غائم",
  45: "ضباب", 48: "ضباب متجمد", 51: "رذاذ خفيف", 53: "رذاذ", 55: "رذاذ كثيف",
  61: "مطر خفيف", 63: "مطر", 65: "مطر غزير", 71: "ثلج خفيف", 73: "ثلج", 75: "ثلج كثيف",
  80: "زخات مطر", 81: "زخات متوسطة", 82: "زخات غزيرة", 95: "عاصفة رعدية", 96: "عاصفة وبرَد", 99: "عاصفة قوية",
};

function buildWeatherSearch(city = "القاهرة") {
  const q = `طقس ${String(city || "القاهرة").trim().slice(0, 80)}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function knownCity(city) {
  const key = normalizeArabic(city);
  return KNOWN_CITIES.find((item) => item.keys.some((alias) => normalizeArabic(alias) === key) || normalizeArabic(item.name) === key) || null;
}

async function locateCity(city) {
  const known = knownCity(city);
  if (known) return { name: known.name, lat: known.lat, lon: known.lon, source: "builtin" };
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ar&format=json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`geocode_http_${response.status}`);
  const data = await response.json();
  const hit = data.results?.[0];
  if (!hit) throw new Error("city_not_found");
  return { name: city, lat: hit.latitude, lon: hit.longitude, source: "geocode" };
}

const MET_UA = "borsa-gpt-bot/1.0.1 (telegram; contact via LOG channel)";

function metCondition(code) {
  const value = String(code || "");
  if (value.startsWith("clear") || value.startsWith("fair")) return "صافٍ";
  if (value.includes("partly")) return "غائم جزئيًا";
  if (value.includes("fog")) return "ضباب";
  if (value.includes("thunder")) return "عاصفة رعدية";
  if (value.includes("heavyrain")) return "مطر غزير";
  if (value.includes("rain") || value.includes("sleet")) return "مطر";
  if (value.includes("snow")) return "ثلج";
  if (value.includes("cloud")) return "غائم";
  return "حالة غير مفهرسة";
}

async function readOpenMeteo(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=Africa%2FCairo`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "user-agent": MET_UA, accept: "application/json" } });
  if (!response.ok) throw new Error(`weather_http_${response.status}`);
  const data = await response.json();
  const current = data.current_weather;
  if (!current || !Number.isFinite(Number(current.temperature))) throw new Error("weather_payload_missing");
  return {
    temperature: Number(current.temperature),
    windKmh: Number(current.windspeed),
    condition: WMO[Number(current.weathercode)] || "حالة غير مفهرسة",
    source: "Open-Meteo",
  };
}

async function readMetNo(lat, lon) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "user-agent": MET_UA, accept: "application/json" } });
  if (!response.ok) throw new Error(`metno_http_${response.status}`);
  const data = await response.json();
  const point = data?.properties?.timeseries?.[0];
  const details = point?.data?.instant?.details;
  const temperature = Number(details?.air_temperature);
  const wind = Number(details?.wind_speed);
  if (!Number.isFinite(temperature) || !Number.isFinite(wind)) throw new Error("metno_payload_missing");
  const symbol = point?.data?.next_1_hours?.summary?.symbol_code || point?.data?.next_6_hours?.summary?.symbol_code || "";
  return { temperature, windKmh: wind * 3.6, condition: metCondition(symbol), source: "MET Norway" };
}

async function readCurrent(lat, lon) {
  try { return await readOpenMeteo(lat, lon); }
  catch (error) {
    try { return await readMetNo(lat, lon); }
    catch (fallback) { throw new Error(`${error.message}; ${fallback.message}`); }
  }
}

async function getWeatherSummary(_ai, city = "القاهرة") {
  const cleanCity = String(city || "القاهرة").trim().slice(0, 80) || "القاهرة";
  const searchUrl = buildWeatherSearch(cleanCity);
  try {
    const place = await locateCity(cleanCity);
    const current = await readCurrent(place.lat, place.lon);
    return {
      ok: true,
      city: place.name,
      searchUrl,
      message: [
        `🌤 الطقس الآن في ${place.name}`,
        `الحرارة: ${Math.round(current.temperature)}°م`,
        `الرياح: ${Math.round(current.windKmh)} كم/س`,
        `الحالة: ${current.condition}`,
        `المصدر: ${current.source} (قياس حالي، ليس رقمًا مخترعًا).`,
      ].join("\n"),
    };
  } catch (error) {
    return {
      ok: false,
      city: cleanCity,
      searchUrl,
      message: "تعذر جلب الطقس الحي من Open-Meteo، ولم يتم اختراع درجة حرارة.",
      error: redactString(error.message),
    };
  }
}

module.exports = { buildWeatherSearch, getWeatherSummary, knownCity, WMO };
