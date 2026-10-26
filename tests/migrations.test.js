"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { MIGRATION_FILES, MIGRATION_LOCK_KEY, runMigrations } = require("../core/migrations");

async function successCase() {
  const calls = [];
  const db = {
    async withTransaction(fn) {
      calls.push("BEGIN");
      try { const result = await fn({ query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } }); calls.push("COMMIT"); return result; }
      catch (e) { calls.push("ROLLBACK"); throw e; }
    }
  };
  const result = await runMigrations({ db, rootDir: "/project", readFile: (file, encoding) => { assert.equal(encoding, "utf8"); calls.push({ read: file }); return `-- ${path.basename(file)}`; } });
  assert.equal(result.applied, 16);
  assert.deepEqual(result.files, [...MIGRATION_FILES]);
  assert.equal(calls[0], "BEGIN");
  assert.deepEqual(calls[1], { sql: "SELECT pg_advisory_xact_lock($1)", params: [MIGRATION_LOCK_KEY] });
  assert.equal(calls.filter(x => x && typeof x === "object" && "sql" in x).length, 17, "lock plus 16 migration statements should run in one transaction");
  assert.equal(calls.at(-1), "COMMIT");
  assert.ok(calls.indexOf("COMMIT") > calls.findIndex(x => x?.read?.endsWith(MIGRATION_FILES.at(-1))));
}

async function failureCase() {
  const calls = [];
  const db = { async withTransaction(fn) { calls.push("BEGIN"); try { const r = await fn({ query: async sql => { calls.push(sql); if (sql.includes("-- 002_operational.sql")) throw new Error("migration failure"); } }); calls.push("COMMIT"); return r; } catch (e) { calls.push("ROLLBACK"); throw e; } } };
  await assert.rejects(() => runMigrations({ db, rootDir: "/project", readFile: file => `-- ${path.basename(file)}` }), /migration failure/);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.includes("COMMIT"), false);
  assert.equal(calls.some(x => typeof x === "string" && x.includes("-- 003_message_cache.sql")), false, "must stop after first failed migration");
}

(async () => {
  await successCase();
  await failureCase();
  await assert.rejects(() => runMigrations({ db: {}, rootDir: "/project" }), /withTransaction/);
  console.log("transactional migration runner tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
