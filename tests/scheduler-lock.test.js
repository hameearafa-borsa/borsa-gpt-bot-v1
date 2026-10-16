"use strict";
const assert = require("node:assert/strict");
const { dispatchDue } = require("../modules/scheduler");

(async () => {
  let sent = 0, released = 0, queriedDue = 0;
  const client = {
    async query(sql) {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("FROM scheduled_messages")) { queriedDue++; return { rows: [{ id: 1, chat_id: -1001, message_text: "hello", schedule_kind: "once" }], rowCount: 1 }; }
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }] };
      return { rows: [], rowCount: 1 };
    }, release() { released++; }
  };
  const pool = { async connect() { return client; } };
  const result = await dispatchDue(pool, { async sendMessage() { sent++; } });
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, false);
  assert.equal(sent, 1);
  assert.equal(queriedDue, 1);
  assert.equal(released, 1);

  let dueQueries = 0;
  const lockedPool = { async connect() { return {
    async query(sql) { if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: false }] }; if (sql.includes("FROM scheduled_messages")) dueQueries++; return { rows: [] }; },
    release() {}
  }; } };
  const skipped = await dispatchDue(lockedPool, { async sendMessage() { throw new Error("must not send"); } });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "scheduler_lock_busy");
  assert.equal(dueQueries, 0);
  console.log("scheduler advisory-lock tests: OK");
})().catch(error => { console.error(error); process.exit(1); });
