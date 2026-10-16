"use strict";
const assert = require("node:assert/strict");
const { buildChemicalLinks, validChemicalLinks, renderChemicalLinks } = require("../core/links");
const { makeReport, formatReport, safeValue, redactString, log } = require("../core/diagnostics");
const links = buildChemicalLinks("صابون سائل ٢ لتر");
assert.ok(validChemicalLinks(links));
assert.match(links.google, /%D8/);
assert.match(links.youtube, /^https:\/\/www\.youtube\.com\/results\?/);
assert.equal(renderChemicalLinks(links).includes("قناة التركيبات"), true);
assert.equal(validChemicalLinks({...links, google:"javascript:alert(1)"}), false);
assert.equal(validChemicalLinks({...links, youtube:"https://youtube.com.evil.test/"}), false);
assert.equal(safeValue({OPENAI_API_KEY:"should-never-leak", nested:{DATABASE_URL:"secret"}}).OPENAI_API_KEY, "[REDACTED]");
const report = makeReport({module:"price-monitor", stage:"db-save", action:"insert", error:Object.assign(new Error("ECONNABORTED"),{code:"ECONNABORTED"}), details:{OPENAI_API_KEY:"should-never-leak", count:4}});
assert.match(report.report_id, /^V1-/);
assert.equal(JSON.stringify(report).includes("should-never-leak"), false);
assert.match(formatReport(report), /أرسل هذا التقرير كاملًا إلى ChatGPT/);
assert.equal(redactString("first\n  second"), "first\n  second");
const oldLog = console.log;
let loggedLine = "";
console.log = (...args) => { loggedLine = args.join(" "); };
try {
  const row = log({ input: "first\n  second", severity: "info" });
  assert.equal(row.input_summary, "first second");
  assert.match(loggedLine, /first second/);
  assert.doesNotMatch(loggedLine, /first\\n  second/);
} finally { console.log = oldLog; }

console.log("links + diagnostics tests: OK");
