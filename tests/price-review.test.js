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
  const callbackData = keyboard.inline_keyboard.flat().map(button => button.callback_data).sort();
  assert.deepEqual(callbackData, ["prv:approve:42", "prv:edit:42", "prv:ignore:42", "prv:new:42"].sort(),
    "all review buttons must use the callback prefixes registered by index.js");
  const indexSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
  assert.ok(indexSource.includes("prv:(approve|new|ignore):"),
    "approve/new/ignore callback handler must match the keyboard payloads");
  assert.ok(indexSource.includes("prv:edit:"),
    "edit callback handler must match the keyboard payloads");
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
  assert.match(calls[2].sql, /notification_claim_token=NULL, notification_claimed_at=NULL/);
  assert.match(calls[0].sql, /WHERE id=\$4 AND decision='pending'/);
  assert.equal(calls[0].params[0], "accepted");
  assert.equal(calls[2].params[0], "accepted");

  const ignoredCalls = [];
  const ignoredDb = { async withTransaction(fn) { return fn({ async query(sql, params) {
    ignoredCalls.push({ sql, params });
    if (sql.includes("UPDATE price_observations")) return { rowCount: 1, rows: [{ ...row, id: 45 }] };
    return { rowCount: 1, rows: [] };
  } }); } };
  const ignored = await resolveReview({ db: ignoredDb, id: 45, action: "ignore", reviewerId: 7 });
  assert.equal(ignored.ok, true);
  assert.equal(ignoredCalls[0].params[0], "ignored", "rejecting a price should retain its observation with ignored decision");
  assert.match(ignoredCalls[1].sql, /UPDATE price_review_queue SET status=\$1/);
  assert.equal(ignoredCalls[1].params[0], "ignored", "rejecting a price should resolve its queue entry too");
  const editedCalls = [];
  const editedDb = { async withTransaction(fn) { return fn({ async query(sql, params) {
    editedCalls.push({ sql, params }); return { rowCount: 1, rows: [{ id: 42 }] };
  } }); } };
  const edited = await saveEditedReview({ db: editedDb, id: 42, reviewerId: 7, productText: "منظف مصحح", price: 23, weightG: 500 });
  assert.equal(edited.ok, true);
  assert.match(editedCalls[0].sql, /decision='accepted'/);
  assert.match(editedCalls[1].sql, /status='accepted'/);
  assert.match(editedCalls[1].sql, /notification_claim_token=NULL, notification_claimed_at=NULL/);

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
