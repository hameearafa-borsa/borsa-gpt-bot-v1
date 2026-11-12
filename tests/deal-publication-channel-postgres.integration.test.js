"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { Pool } = require("pg");
const { runMigrations } = require("../core/migrations");

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  console.error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
  process.exit(1);
}

(async () => {
  const admin = new Pool({ connectionString });
  let pool;
  const schema = "deal_publication_channel_it_" + process.pid;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const db = {
      async withTransaction(fn) {
        const client = await pool.connect();
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

    const migrationResult = await runMigrations({ db, rootDir: path.join(__dirname, "..") });
    assert.ok(migrationResult.files.includes("033_deal_publication_metro_channel_kind.sql"));

    const allowedKinds = [
      "amazon", "catalogs", "other_sites", "best_deals",
      "online_stores", "market_stores", "market_stores_2", "metro_stores"
    ];
    for (const [index, channelKind] of allowedKinds.entries()) {
      const result = await pool.query(
        "INSERT INTO deal_publications(batch_key,channel_kind,chat_id,item_count,status) VALUES($1,$2,$3,0,'prepared') RETURNING channel_kind",
        [`2026-11-12-channel-test-${index}`, channelKind, -1001234567890]
      );
      assert.equal(result.rows[0].channel_kind, channelKind,
        "PostgreSQL must accept scheduled channel kind " + channelKind);
    }

    await assert.rejects(
      () => pool.query(
        "INSERT INTO deal_publications(batch_key,channel_kind,chat_id,item_count,status) VALUES($1,$2,$3,0,'prepared')",
        ["2026-11-12-channel-test-invalid", "unknown_newsletter", -1001234567890]
      ),
      error => error.code === "23514",
      "PostgreSQL must continue rejecting unknown publication channel kinds"
    );

    console.log("DEAL PUBLICATION CHANNEL POSTGRESQL INTEGRATION TEST: OK");
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
