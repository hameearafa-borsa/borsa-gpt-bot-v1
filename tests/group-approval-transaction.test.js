"use strict";
const assert = require("node:assert/strict");
const { approvePendingGroup } = require("../core/group-approval");

function fakeDb({ failApprovalUpdate = false, initialStatus = "pending" } = {}) {
  const state = { authorized: false, status: initialStatus, calls: [] };
  const db = {
    async withTransaction(fn) {
      const before = { ...state };
      const client = {
        async query(sql, params) {
          state.calls.push({ sql, params });
          if (sql.includes("SELECT status FROM pending_group_approvals")) {
            return { rows: [{ status: state.status }] };
          }
          if (sql.includes("INSERT INTO authorized_chats")) {
            state.authorized = true;
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("UPDATE pending_group_approvals")) {
            if (failApprovalUpdate) throw new Error("simulated approval-row failure");
            if (state.status !== "pending") return { rowCount: 0, rows: [] };
            state.status = "approved";
            return { rowCount: 1, rows: [] };
          }
          throw new Error("Unexpected SQL: " + sql);
        }
      };
      try { return await fn(client); }
      catch (error) { Object.assign(state, before); throw error; }
    }
  };
  return { db, state };
}

(async () => {
  {
    const { db, state } = fakeDb();
    const result = await approvePendingGroup({ db, chatId: -100123, chatType: "supergroup", ownerUserId: 77, approvedBy: 5256328556 });
    assert.deepEqual(result, { chatId: -100123, ownerUserId: 77, approvedBy: 5256328556 });
    assert.equal(state.authorized, true);
    assert.equal(state.status, "approved");
  }
  {
    const { db, state } = fakeDb({ failApprovalUpdate: true });
    await assert.rejects(() => approvePendingGroup({ db, chatId: -100123, chatType: "supergroup", ownerUserId: 77, approvedBy: 5256328556 }), /simulated approval-row failure/);
    assert.equal(state.authorized, false, "transaction rollback must prevent active access when approval persistence fails");
    assert.equal(state.status, "pending");
  }
  {
    const { db, state } = fakeDb({ initialStatus: "approved" });
    await assert.rejects(() => approvePendingGroup({ db, chatId: -100123, chatType: "supergroup", ownerUserId: 77, approvedBy: 5256328556 }), /GROUP_APPROVAL_NOT_PENDING/);
    assert.equal(state.authorized, false, "non-pending requests must not activate access");
  }
  console.log("GROUP APPROVAL TRANSACTION UNIT TESTS (FAKE DB): OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
