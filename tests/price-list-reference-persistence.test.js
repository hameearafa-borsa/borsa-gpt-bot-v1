"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { deterministicList, parseListMetadata } = require("../modules/price-list");
const { persistPriceList } = require("../modules/price-list-persistence");

(async () => {
  const sourceText = fs.readFileSync(path.join(__dirname, "fixtures-unilever-oct-2026.txt"), "utf8");
  const metadata = parseListMetadata(sourceText);
  const rows = deterministicList(sourceText);
  assert.equal(metadata.company, "شركة يونيليفر");
  assert.equal(metadata.month, "أكتوبر 2026");
  assert.equal(metadata.priceType, "أسعار جملة");
  assert.equal(rows.length, 66);
  assert.equal(rows.filter(row => row.decision === "accepted").length, 66);

  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("INSERT INTO price_list_runs")) return { rows: [{ id: 1234 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }
  };
  const result = await persistPriceList(client, {
    message: { chatId: -100123, messageId: 987 },
    sourceText,
    parsedList: metadata,
    rows
  });
  assert.deepEqual(result, { runId: 1234, extracted: 66, accepted: 66, referenceKind: "wholesale" });
  assert.equal(queries.length, 133, "one run + 66 item rows + 66 accepted reference rows");
  assert.equal(queries.filter(q => q.sql.includes("INSERT INTO price_list_items")).length, 66);
  const references = queries.filter(q => q.sql.includes("INSERT INTO price_reference_observations"));
  assert.equal(references.length, 66);
  assert.ok(references.every(q => q.params[4] === "أسعار جملة" && q.params[5] === "wholesale" && q.params[17] === "accepted"));
  assert.ok(references.some(q => /سيجنال 120مل/.test(q.params[16]) && q.params[13] === "بالقطعة"),
    "per-piece toothpaste row and its raw source line must be persisted");
  assert.ok(references.some(q => /كلير أكياس 5 مل الكرتونة/.test(q.params[16]) && q.params[13] === "بالكرتونة"),
    "explicit carton rows must be persisted as carton references");
  assert.ok(references.some(q => /قرنفل 100مل \+25مل هدية/.test(q.params[16])),
    "promotional raw line must survive persistence so comparison logic can reject unsafe base-price matching");
  assert.ok(!queries.some(q => /INSERT INTO price_observations/.test(q.sql)),
    "official company catalogs must not be persisted as live group sightings");
  console.log("UNILEVER PRICE-LIST REFERENCE PERSISTENCE TEST: OK (66 reference rows, 66 catalog rows)");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
