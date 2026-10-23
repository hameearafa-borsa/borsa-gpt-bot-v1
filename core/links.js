"use strict";
function encodeQuery(value = "") { return encodeURIComponent(String(value).trim().replace(/\s+/g, " ")); }
function validHttps(raw, host) {
  try { const u = new URL(raw); return u.protocol === "https:" && u.hostname === host && !u.username && !u.password; }
  catch { return false; }
}
function buildChemicalLinks(product = "منظفات") {
  const q = String(product || "منظفات").trim().slice(0, 160) || "منظفات";
  const links = {
    formulaChannel: process.env.FORMULA_CHANNEL_URL || "https://t.me/formula_channel_for_borsa",
    google: `https://www.google.com/search?q=${encodeQuery(q)}`,
    youtube: `https://www.youtube.com/results?search_query=${encodeQuery(q)}`
  };
  return validChemicalLinks(links) ? links : null;
}
function validChemicalLinks(links) {
  return Boolean(links && validHttps(links.formulaChannel, "t.me") && validHttps(links.google, "www.google.com") && validHttps(links.youtube, "www.youtube.com"));
}
function escapeHtml(value = "") { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function renderChemicalLinks(links) {
  if (!validChemicalLinks(links)) return "";
  return [
    `📚 <a href="${escapeHtml(links.formulaChannel)}">قناة التركيبات المحفوظة</a>`,
    `🔎 <a href="${escapeHtml(links.google)}">نتائج البحث على Google</a>`,
    `▶️ <a href="${escapeHtml(links.youtube)}">نتائج البحث على YouTube</a>`
  ].join("\n");
}
module.exports = { encodeQuery, validHttps, buildChemicalLinks, validChemicalLinks, escapeHtml, renderChemicalLinks };
