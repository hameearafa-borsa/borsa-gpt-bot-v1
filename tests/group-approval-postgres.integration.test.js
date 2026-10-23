"use strict";

const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { approvePendingGroup } = require("../core/group-approval");

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  console.error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
  process.exit(1);
}

(async () => {
  const admin = new Pool({ connectionString });
  let db;
  const schema = "group_approval_it_" + process.pid;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new Pool({
      connectionString,
      options: `-c search_path=${schema}`
    });

    await db.query(`
      CREATE TABLE pending_group_approvals (
        chat_id BIGINT PRIMARY KEY,
        status TEXT NOT NULL,
        approved_by BIGINT,
        approved_at TIMESTAMPTZ,
        owner_user_id BIGINT,
        chat_type TEXT NOT NULL
      );
      CREATE TABLE authorized_chats (
        chat_id BIGINT PRIMARY KEY,
        chat_type TEXT NOT NULL,
        owner_user_id BIGINT,
        authorized_by BIGINT,
        active BOOLEAN NOT NULL DEFAULT TRUE
      );
      CREATE FUNCTION reject_approval_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.chat_id = -100002 THEN
          RAISE EXCEPTION 'simulated approval persistence failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_approval_update
      BEFORE UPDATE ON pending_group_approvals
      FOR EACH ROW EXECUTE FUNCTION reject_approval_update();
    `);

    const txDb = {
      async withTransaction(fn) {
        const client = await db.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          try { await client.query("ROLLBACK"); } catch {}
          throw error;
        } finally {
          client.release();
        }
      }
    };

    await db.query(
      "INSERT INTO pending_group_approvals (chat_id,status,chat_type) VALUES ($1,'pending','supergroup'),($2,'pending','supergroup'),($3,'approved','supergroup')",
      [-100001, -100002, -100003]
    );

    const result = await approvePendingGroup({
      db: txDb, chatId: -100001, chatType: "supergroup",
      ownerUserId: 77, approvedBy: 5256328556
    });
    assert.deepEqual(result, {
      chatId: -100001, ownerUserId: 77, approvedBy: 5256328556
    });
    const approved = await db.query(
      "SELECT status, approved_by, owner_user_id FROM pending_group_approvals WHERE chat_id=$1",
      [-100001]
    );
    const authorized = await db.query(
      "SELECT chat_type, owner_user_id, authorized_by, active FROM authorized_chats WHERE chat_id=$1",
      [-100001]
    );
    assert.equal(approved.rows[0].status, "approved");
    assert.equal(String(approved.rows[0].approved_by), "5256328556");
    assert.equal(String(approved.rows[0].owner_user_id), "77");
    assert.equal(authorized.rows.length, 1);
    assert.equal(authorized.rows[0].chat_type, "supergroup");
    assert.equal(String(authorized.rows[0].owner_user_id), "77");
    assert.equal(String(authorized.rows[0].authorized_by), "5256328556");
    assert.equal(authorized.rows[0].active, true);

    await assert.rejects(
      () => approvePendingGroup({
        db: txDb, chatId: -100002, chatType: "supergroup",
        ownerUserId: 88, approvedBy: 5256328556
      }),
      /simulated approval persistence failure/
    );
    const rolledBack = await db.query(
      "SELECT status FROM pending_group_approvals WHERE chat_id=$1",
      [-100002]
    );
    const noAccess = await db.query(
      "SELECT chat_id FROM authorized_chats WHERE chat_id=$1",
      [-100002]
    );
    assert.equal(rolledBack.rows[0].status, "pending");
    assert.equal(noAccess.rows.length, 0, "failed approval must roll back access activation");

    await assert.rejects(
      () => approvePendingGroup({
        db: txDb, chatId: -100003, chatType: "supergroup",
        ownerUserId: 99, approvedBy: 5256328556
      }),
      /GROUP_APPROVAL_NOT_PENDING/
    );
    const noRepeatAccess = await db.query(
      "SELECT chat_id FROM authorized_chats WHERE chat_id=$1",
      [-100003]
    );
    assert.equal(noRepeatAccess.rows.length, 0);

    console.log("GROUP APPROVAL POSTGRESQL INTEGRATION TESTS: OK");
  } finally {
    if (db) await db.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
