"use strict";
const assert = require("node:assert/strict");
const { identityKey, formatReviewMessage, reviewKeyboard, resolveReview, saveEditedReview } = require("../modules/price-review");

(async () => {
  const row = { product_text: "منظف جديد", weight_g: 500, volume_ml: null, pack_count: 1, brand_key: null, raw_line: "منظف جديد 500 جم جملة 22 ج", package_sale_price: 22, price_kind: "wholesale" };
  assert.equal(identityKey(row), identityKey({ ...row }));
  assert.notEqual(identityKey(row), identityKey({ ...row, weight_g: 750 }));
  assert.match(formatReviewMessage(42, row), /مراجعة سعر معلّق #42/);
  const keyboard = reviewKeyboard(42);
  assert.equal(keyboard.inline_keyboard.flat().length, 4);
  assert.ok(keyboard.inline_keyboard.flat().some(button => button.callback_data === "prv:new:42"));
  const calls = [];
  const db = { async withTransaction(fn) { return fn({ async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("UPDATE price_observations")) return { rowCount: 1, rows: [{ ...row, id: 42 }] };
    return { rowCount: 1, rows: [] };
  } }); } };
  const approved = await resolveReview({ db, id: 42, action: "new", reviewerId: 7 });
  assert.equal(approved.ok, true);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].sql.includes("reviewed_price_products"));
  assert.ok(calls[2].sql.includes("price_review_queue"));
  const editedCalls = [];
  const editedDb = { async withTransaction(fn) { return fn({ async query(sql, params) {
    editedCalls.push({ sql, params }); return { rowCount: 1, rows: [{ id: 42 }] };
  } }); } };
  const edited = await saveEditedReview({ db: editedDb, id: 42, reviewerId: 7, productText: "منظف مصحح", price: 23, weightG: 500 });
  assert.equal(edited.ok, true);
  assert.match(editedCalls[0].sql, /decision='accepted'/);
  assert.match(editedCalls[1].sql, /status='accepted'/);

  // A missing queue row must fail the transaction rather than leave the
  // observation accepted while its review request is still unresolved.
  const missingQueueDb = { async withTransaction(fn) { return fn({ async query(sql) {
    if (sql.includes("UPDATE price_observations")) return { rowCount: 1, rows: [{ ...row, id: 43 }] };
    if (sql.includes("reviewed_price_products")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE price_review_queue")) return { rowCount: 0, rows: [] };
    throw new Error("unexpected query");
  } }); } };
  await assert.rejects(
    resolveReview({ db: missingQueueDb, id: 43, action: "new", reviewerId: 7 }),
    /price_review_queue_missing_or_resolved/
  );
  const missingEditQueueDb = { async withTransaction(fn) { return fn({ async query(sql) {
    if (sql.includes("UPDATE price_observations")) return { rowCount: 1, rows: [{ id: 44 }] };
    if (sql.includes("UPDATE price_review_queue")) return { rowCount: 0, rows: [] };
    throw new Error("unexpected query");
  } }); } };
  await assert.rejects(
    saveEditedReview({ db: missingEditQueueDb, id: 44, reviewerId: 7, productText: "منظف مصحح", price: 23 }),
    /price_review_queue_missing_or_resolved/
  );
  console.log("price review identity, controls, atomic resolution, edit-save and queue consistency tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
