"use strict";
const assert = require("node:assert/strict");
const { identityKey, formatReviewMessage, reviewKeyboard, resolveReview, saveEditedReview } = require("../modules/price-review");
const { buildPriceMemory, resolveFromMemory } = require("../modules/price-memory");

(async () => {
  const row = { product_text: "منظف جديد", weight_g: 500, volume_ml: null, pack_count: 1, brand_key: null, raw_line: "منظف جديد 500 جم 10 قطع 100 ج", package_sale_price: 100, price_kind: "wholesale_candidate", confidence: 0.72, unit_price_type: "بالكرتونة" };
  assert.equal(identityKey(row), identityKey({ ...row }));
  assert.notEqual(identityKey(row), identityKey({ ...row, weight_g: 750 }));
  assert.notEqual(identityKey(row), identityKey({ ...row, package_type: "sack" }),
    "a sack and a non-sack package must not share reviewer identity memory");
  assert.notEqual(identityKey({ ...row, offer_extra_weight_g: null }), identityKey({ ...row, offer_extra_weight_g: 300 }),
    "an extra-weight offer must not inherit approval from the base-weight product");
  assert.equal(identityKey({ ...row, pack_count: 24 }), identityKey({ ...row, pack_count: 1 }),
    "carton count changes should not create a new reviewer identity");
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
    if (sql.includes("UPDATE price_observations")) return { rowCount: 1, rows: [{ ...row, id: 42, decision: "accepted", price_kind: "wholesale", confidence: 0.9, explicit_wholesale_label_price: 100 }] };
    return { rowCount: 1, rows: [] };
  } }); } };
  const approved = await resolveReview({ db, id: 42, action: "new", reviewerId: 7 });
  assert.equal(approved.ok, true);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].sql.includes("reviewed_price_products"));
  assert.ok(calls[2].sql.includes("price_review_queue"));
  assert.match(calls[2].sql, /notification_claim_token=NULL, notification_claimed_at=NULL/);
  assert.match(calls[0].sql, /WHERE id=\$4 AND decision='pending'/);
  assert.match(calls[0].sql, /needs_review=FALSE/, "reviewed observations must clear the unresolved review flag");
  assert.equal(calls[0].params[0], "accepted");
  assert.equal(calls[2].params[0], "accepted");
  assert.match(calls[0].sql, /price_kind=CASE WHEN \$1='accepted' THEN 'wholesale'/,
    "a human-approved price must become a wholesale observation eligible for trusted memory");
  assert.match(calls[0].sql, /confidence=CASE WHEN \$1='accepted' THEN GREATEST\(COALESCE\(confidence, 0\), 0\.9\)/,
    "human approval must meet the trusted-memory confidence threshold");
  assert.match(calls[0].sql, /explicit_wholesale_label_price=CASE WHEN \$1='accepted' THEN package_sale_price/,
    "the explicitly approved wholesale amount must be retained");
  assert.match(calls[0].sql, /GREATEST\(COALESCE\(confidence, 0\), 0\.9\)/,
    "approval must safely raise even a null confidence to the trusted threshold");
  const approvedMemory = buildPriceMemory([approved.row]);
  const afterApproval = resolveFromMemory({
    product_text: "منظف جديد", weight_g: 500, volume_ml: null,
    offer_extra_weight_g: null, package_type: null, pack_count: null,
    unit_price_type: "بالكرتونة", price_kind: "wholesale_candidate"
  }, approvedMemory);
  assert.equal(afterApproval.resolved, true,
    "a human-approved pending wholesale candidate must become usable by trusted price memory");
  assert.equal(afterApproval.price_kind, "wholesale");
  assert.equal(afterApproval.unit_price_type, "بالكرتونة");
  assert.equal(afterApproval.pack_count, 1);

  const ignoredCalls = [];
  const ignoredDb = { async withTransaction(fn) { return fn({ async query(sql, params) {
    ignoredCalls.push({ sql, params });
    if (sql.includes("UPDATE price_observations")) return { rowCount: 1, rows: [{ ...row, id: 45, decision: "ignored", price_kind: "wholesale", confidence: 1, package_sale_price: 100 }] };
    return { rowCount: 1, rows: [] };
  } }); } };
  const ignored = await resolveReview({ db: ignoredDb, id: 45, action: "ignore", reviewerId: 7 });
  assert.equal(ignored.ok, true);
  assert.equal(ignoredCalls[0].params[0], "ignored", "rejecting a price should retain its observation with ignored decision");
  assert.match(ignoredCalls[1].sql, /UPDATE price_review_queue SET status=\$1/);
  assert.equal(ignoredCalls[1].params[0], "ignored", "rejecting a price should resolve its queue entry too");
  assert.equal(buildPriceMemory([ignored.row]).size, 0,
    "a rejected observation must never enter trusted price memory");
  const editedCalls = [];
  const editedDb = { async withTransaction(fn) { return fn({ async query(sql, params) {
    editedCalls.push({ sql, params });
    if (sql.includes("UPDATE price_observations")) return { rowCount: 1, rows: [{
      id: 42, product_text: params[0], package_sale_price: params[1], weight_g: params[2],
      volume_ml: params[3], pack_count: params[4], brand_key: params[5], package_type: null,
      offer_extra_weight_g: null, price_kind: "wholesale", decision: "accepted",
      confidence: 1, unit_price_type: "بالكرتونة", needs_review: false
    }] };
    return { rowCount: 1, rows: [{ id: 42 }] };
  } }); } };
  const edited = await saveEditedReview({ db: editedDb, id: 42, reviewerId: 7, productText: "أريال مسحوق", price: 23, weightG: 500 });
  assert.equal(edited.ok, true);
  assert.match(editedCalls[0].sql, /decision='accepted'/);
  assert.match(editedCalls[0].sql, /needs_review=FALSE/);
  assert.equal(edited.row.decision, "accepted");
  assert.equal(edited.row.confidence, 1);
  assert.equal(edited.row.price_kind, "wholesale");
  const editedMemory = buildPriceMemory([edited.row]);
  const editedResolution = resolveFromMemory({
    product_text: "أريال مسحوق", weight_g: 500, volume_ml: null,
    offer_extra_weight_g: null, package_type: null, unit_price_type: "بالكرتونة",
    price_kind: "wholesale_candidate"
  }, editedMemory);
  assert.equal(editedResolution.resolved, true,
    "a manually edited and approved price must be reusable from trusted price memory");
  assert.match(editedCalls[0].sql, /explicit_wholesale_label_price=\$2/,
    "a manually corrected wholesale price must update its dedicated field too");
  assert.match(editedCalls[0].sql, /brand_key=\$6/,
    "manual correction must refresh the brand key from the corrected product name");
  assert.equal(editedCalls[0].params[5], "arial",
    "correcting a product to a known brand must persist the registry brand key");
  assert.match(editedCalls[1].sql, /product_identity_key/);
  assert.match(editedCalls[2].sql, /reviewed_price_products/);
  assert.equal(editedCalls[2].params[1], "أريال مسحوق", "manual correction must be remembered under the corrected product identity");
  assert.equal(editedCalls[2].params[5], "arial", "reviewer memory must use the corrected brand identity");
  assert.match(editedCalls[3].sql, /status='accepted'/);
  assert.match(editedCalls[3].sql, /notification_claim_token=NULL, notification_claimed_at=NULL/);

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
    if (sql.includes("INSERT INTO reviewed_price_products")) return { rowCount: 1, rows: [] };
    if (sql.includes("UPDATE price_review_queue")) return { rowCount: 0, rows: [] };
    throw new Error("unexpected query");
  } }); } };
  await assert.rejects(
    saveEditedReview({ db: missingEditQueueDb, id: 44, reviewerId: 7, productText: "منظف مصحح", price: 23 }),
    /price_review_queue_missing_or_resolved/
  );
  // Repeated or stale reviewer actions must be idempotently rejected.
  const staleCalls = [];
  const staleDb = { async withTransaction(fn) { return fn({ async query(sql) {
    staleCalls.push(sql);
    if (sql.includes("UPDATE price_observations")) return { rowCount: 0, rows: [] };
    throw new Error("stale review must stop after the guarded observation update");
  } }); } };
  const staleApproval = await resolveReview({ db: staleDb, id: 42, action: "approve", reviewerId: 7 });
  assert.deepEqual(staleApproval, { ok: false, reason: "already_resolved" });
  assert.equal(staleCalls.length, 1,
    "a stale approval must not modify reviewer memory or the review queue");
  const staleEditCalls = [];
  const staleEditDb = { async withTransaction(fn) { return fn({ async query(sql) {
    staleEditCalls.push(sql);
    if (sql.includes("UPDATE price_observations")) return { rowCount: 0, rows: [] };
    throw new Error("stale edit must stop after the guarded observation update");
  } }); } };
  const staleEdit = await saveEditedReview({
    db: staleEditDb, id: 42, reviewerId: 7, productText: "أريال مسحوق", price: 23, weightG: 500
  });
  assert.deepEqual(staleEdit, { ok: false, reason: "already_resolved" });
  assert.equal(staleEditCalls.length, 1,
    "a stale edit must not update product identity, reviewer memory, or queue state");

  console.log("price review identity, controls, atomic resolution, edit-save and queue consistency tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
