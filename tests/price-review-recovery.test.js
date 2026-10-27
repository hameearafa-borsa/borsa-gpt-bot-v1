"use strict";
const assert = require("node:assert/strict");
const { recoverPendingNotifications } = require("../modules/price-review-recovery");

(async () => {
  const rows = [
    { observation_id: 51, target_log_chat_id: -10055, product_text: "منظف مجهول", raw_line: "منظف مجهول 20 جنيه", package_sale_price: 20, price_kind: "wholesale" },
    { observation_id: 52, target_log_chat_id: -10055, product_text: "مسحوق غير معروف", raw_line: "مسحوق غير معروف 30 جنيه", package_sale_price: 30, price_kind: "wholesale" },
  ];
  const queries = [];
  const sent = [];
  const deleted = [];
  const errors = [];
  const db = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes("INSERT INTO price_review_queue")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT q.observation_id")) return { rows, rowCount: rows.length };
    if (sql.includes("UPDATE price_review_queue")) return { rows: [{ observation_id: params[1] }], rowCount: 1 };
    throw new Error("unexpected query");
  } };
  const telegram = {
    async sendMessage(chatId, message, options) {
      sent.push({ chatId, message, options });
      return { message_id: 900 + sent.length };
    },
    async deleteMessage(chatId, messageId) { deleted.push({ chatId, messageId }); return true; }
  };
  const stats = await recoverPendingNotifications({ db, telegram, defaultLogChatId: -10055, onError: async (...args) => errors.push(args) });
  assert.deepEqual(stats, { found: 2, sent: 2, failed: 0 });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].options.reply_markup.inline_keyboard.flat().length, 4);
  assert.match(sent[0].message, /مراجعة سعر معلّق #51/);
  assert.match(queries[0].sql, /po\.decision = 'pending' AND q\.observation_id IS NULL/);
  assert.match(queries[1].sql, /status = 'pending' AND q\.log_message_id IS NULL/);
  assert.equal(queries[2].params[0], 901);
  assert.equal(errors.length, 0);
  assert.equal(deleted.length, 0);

  let failureDeleteCount = 0;
  const failingDb = { async query(sql) {
    if (sql.includes("INSERT INTO price_review_queue")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT q.observation_id")) return { rows: [rows[0]], rowCount: 1 };
    if (sql.includes("UPDATE price_review_queue")) throw new Error("database write failed");
    throw new Error("unexpected query");
  } };
  const failingStats = await recoverPendingNotifications({
    db: failingDb,
    telegram: {
      async sendMessage() { return { message_id: 999 }; },
      async deleteMessage() { failureDeleteCount += 1; }
    },
    onError: async (error, details) => {
      assert.match(error.message, /database write failed/);
      assert.equal(details.observationId, 51);
    }
  });
  assert.deepEqual(failingStats, { found: 1, sent: 0, failed: 1 });
  assert.equal(failureDeleteCount, 1);

  let sendErrorReported = false;
  const sendFailStats = await recoverPendingNotifications({
    db: { async query(sql) {
      if (sql.includes("INSERT INTO price_review_queue")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT q.observation_id")) return { rows: [rows[0]], rowCount: 1 };
      throw new Error("unexpected query");
    } },
    telegram: { async sendMessage() { throw new Error("telegram unavailable"); } },
    onError: async error => { sendErrorReported = error.message === "telegram unavailable"; }
  });
  assert.deepEqual(sendFailStats, { found: 1, sent: 0, failed: 1 });
  assert.equal(sendErrorReported, true);

  // A crash after saving a pending observation but before queue insertion is repaired at startup.
  const rebuiltCalls = [];
  const rebuiltSends = [];
  const rebuilt = await recoverPendingNotifications({
    db: { async query(sql, params) {
      rebuiltCalls.push({ sql, params });
      if (sql.includes("INSERT INTO price_review_queue")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT q.observation_id")) return { rows: [rows[0]], rowCount: 1 };
      if (sql.includes("UPDATE price_review_queue")) return { rows: [{ observation_id: params[1] }], rowCount: 1 };
      throw new Error("unexpected rebuild query");
    } },
    telegram: { async sendMessage(chatId, message, options) {
      rebuiltSends.push({ chatId, message, options });
      return { message_id: 1001 };
    } },
    defaultLogChatId: -10055
  });
  assert.deepEqual(rebuilt, { found: 1, sent: 1, failed: 0 });
  assert.match(rebuiltCalls[0].sql, /LEFT JOIN price_review_queue q ON q\.observation_id = po\.id/);
  assert.match(rebuiltCalls[0].sql, /ON CONFLICT \(observation_id\) DO NOTHING/);
  assert.equal(rebuiltCalls[0].params[0], -10055);
  assert.equal(rebuiltSends.length, 1);

  console.log("price review pending-notification recovery and failure-path tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
