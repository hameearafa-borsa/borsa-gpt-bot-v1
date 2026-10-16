"use strict";
const assert = require("node:assert/strict");
const { getLiveWeather, getWeatherSummary } = require("../modules/weather");
(async () => {
  const calls = [];
  const fetchJson = async url => {
    calls.push(url);
    if (url.includes("geocoding-api")) return { results: [{ name: "القاهرة", admin1: "القاهرة", country: "مصر", latitude: 30.04, longitude: 31.23 }] };
    return { timezone: "Africa/Cairo", current: { temperature_2m: 27.2, apparent_temperature: 29, relative_humidity_2m: 40, wind_speed_10m: 11, precipitation: 0, weather_code: 1, time: "2026-10-15T11:00" } };
  };
  const result = await getLiveWeather("القاهرة", { fetchJson });
  assert.equal(result.temperature, 27.2);
  assert.equal(result.condition, "صحو غالبًا");
  assert.equal(calls.length, 2);
  const failed = await getWeatherSummary(null, "مدينة غير موجودة", { fetchJson: async () => ({ results: [] }) });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /لن أخمّن/);
  console.log("live weather parser tests: OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
