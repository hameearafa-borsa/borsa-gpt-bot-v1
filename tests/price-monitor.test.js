"use strict";
const assert = require("node:assert/strict");
const { isOwnMessage, isEligibleMessage, observe } = require("../modules/price-monitor");
const registry = require("../data/product-registry.json");

(async () => {
  const base = { chatType: "supergroup", text: "بريكس ارضيات ٢٥ جم جملة ١٨.٧٥ ج" };
  assert.equal(isEligibleMessage({ ...base, isLogChannel: false, isCommand: false, ownMessage: false }), true);
  assert.equal(isEligibleMessage({ ...base, chatType: "private", isLogChannel: false, isCommand: false, ownMessage: false }), false);
  assert.equal(isEligibleMessage({ ...base, isLogChannel: true, isCommand: false, ownMessage: false }), false);
  assert.equal(isEligibleMessage({ ...base, isLogChannel: false, isCommand: true, ownMessage: false }), false);
  assert.equal(isEligibleMessage({ ...base, isLogChannel: false, isCommand: false, ownMessage: true }), false);
  assert.equal(isOwnMessage({ botUserId: 123, fromId: "123" }), true);
  assert.equal(isOwnMessage({ botUserId: 123, fromId: 456 }), false);

  const savedQueries = [];
  const pool = {
    async query(sql, params) {
      savedQueries.push({ sql, params });
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO price_observations")) return { rows: [{ id: 91 }], rowCount: 1 };
      throw new Error("unexpected query");
    }
  };
  const result = await observe({
    pool,
    message: { chatId: -100123, messageId: 456, userId: 789, text: base.text },
    registry
  });
  assert.equal(result.silent, true);
  assert.equal(result.saved, 1);
  assert.equal(result.savedRows[0].id, 91);
  assert.equal(result.accepted[0].price_kind, "wholesale");
  assert.equal(result.accepted[0].package_sale_price, 18.75);
  assert.equal(savedQueries.length, 2);
  assert.ok(savedQueries[1].sql.includes("INSERT INTO price_observations"));

  const noDb = await observe({ message: { text: base.text }, registry });
  assert.equal(noDb.saved, 0);
  assert.equal(noDb.silent, true);

  console.log("price monitor eligibility, extraction, persistence, and silent-mode tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
