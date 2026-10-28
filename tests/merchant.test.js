"use strict";
const assert = require("node:assert/strict");
const { merchantKey, saveMerchant } = require("../modules/merchant-intelligence");
assert.equal(merchantKey({ phone: "+201001234567" }), "+201001234567");
assert.equal(merchantKey({ name: "  محل  النور " }), "محل النور");

(async () => {
  const calls = [];
  let stored = null;
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT * FROM merchants WHERE phone")) return { rows: stored ? [stored] : [] };
      if (sql.includes("INSERT INTO merchants")) {
        stored = { id: 17, name: params[0], activity: params[1], location: params[2], phone: params[3], telegram_username: params[4] };
        return { rows: [stored] };
      }
      if (sql.includes("INSERT INTO merchant_sources")) return { rows: [{ id: 23 }] };
      throw new Error("Unexpected SQL in merchant test");
    }
  };
  const saved = await saveMerchant(pool, {
    name: "تاجر اختبار", activity: "مرصد أسعار", location: "القاهرة",
    phone: "01012345678", telegram_username: "@test_shop"
  }, { chatId: -100123, messageId: 456, userId: 789, rawText: "مسحوق بسعر 100 جنيه" });
  assert.equal(saved.saved, true, "qualified merchant must be persisted automatically");
  assert.equal(saved.merchant.id, 17);
  assert.ok(calls.some(x => x.sql.includes("INSERT INTO merchants")));
  assert.ok(calls.some(x => x.sql.includes("INSERT INTO merchant_sources")), "source provenance must be stored");
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
  console.log("merchant auto-save and deduplication tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
