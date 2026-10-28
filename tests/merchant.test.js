"use strict";
const assert = require("node:assert/strict");
const { merchantKey, saveMerchant } = require("../modules/merchant-intelligence");
assert.equal(merchantKey({ phone: "+201001234567" }), "+201001234567");
assert.equal(merchantKey({ name: "  محل  النور " }), "محل النور");

(async () => {
  const calls = [];
  let stored = null;
  let snapshot = null;
  let failSourceInsert = false;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") { snapshot = stored ? { ...stored } : null; return { rows: [] }; }
      if (sql === "COMMIT") { snapshot = null; return { rows: [] }; }
      if (sql === "ROLLBACK") { stored = snapshot; snapshot = null; return { rows: [] }; }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("SELECT * FROM merchants WHERE phone")) return { rows: stored && stored.phone === params[0] ? [stored] : [] };
      if (sql.includes("INSERT INTO merchants")) {
        stored = { id: 17, name: params[0], activity: params[1], location: params[2], phone: params[3], telegram_username: params[4] };
        return { rows: [stored] };
      }
      if (sql.includes("INSERT INTO merchant_sources")) {
        if (failSourceInsert) throw new Error("simulated source insert failure");
        return { rows: [{ id: 23 }] };
      }
      if (sql.includes("INSERT INTO merchant_history")) return { rows: [] };
      if (sql.includes("UPDATE merchants")) {
        stored = { ...stored, name: params[0], activity: params[1], location: params[2], telegram_username: params[3] || stored.telegram_username };
        return { rows: [stored] };
      }
      throw new Error("Unexpected SQL in merchant test: " + sql);
    },
    release() {}
  };
  const pool = { connect: async () => client };

  const saved = await saveMerchant(pool, {
    name: "تاجر اختبار", activity: "مرصد أسعار", location: "القاهرة",
    phone: "01012345678", telegram_username: "@test_shop"
  }, { chatId: -100123, messageId: 456, userId: 789, rawText: "مسحوق بسعر 100 جنيه" });
  assert.equal(saved.saved, true, "qualified merchant must be persisted automatically");
  assert.equal(saved.merchant.id, 17);
  assert.ok(calls.some(x => x.sql.includes("INSERT INTO merchants")));
  assert.ok(calls.some(x => x.sql.includes("INSERT INTO merchant_sources")), "source provenance must be stored");
  assert.ok(calls.some(x => x.sql === "COMMIT"), "merchant and source must commit together");

  const beforeInvalid = calls.length;
  const invalid = await saveMerchant(pool, { name: "بدون رقم هاتف", phone: "" });
  assert.equal(invalid.saved, false);
  assert.equal(invalid.reason, "invalid_phone");
  assert.equal(calls.length, beforeInvalid, "invalid merchant must not touch the database");

  const duplicate = await saveMerchant(pool, {
    name: "تاجر اختبار", activity: "مرصد أسعار", location: "القاهرة",
    phone: "01012345678", telegram_username: "@test_shop"
  });
  assert.equal(duplicate.saved, false, "repeated identical details must not create a duplicate merchant");

  const prior = { ...stored };
  failSourceInsert = true;
  await assert.rejects(() => saveMerchant(pool, {
    name: "تاجر آخر", activity: "مرصد أسعار", location: "الجيزة",
    phone: "01099998888", telegram_username: "@another_shop"
  }), /simulated source insert failure/);
  assert.deepEqual(stored, prior, "failed source write must roll back the merchant insert");
  assert.ok(calls.some(x => x.sql === "ROLLBACK"), "failed persistence must roll back the transaction");
  console.log("merchant auto-save, provenance, deduplication and transaction tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
