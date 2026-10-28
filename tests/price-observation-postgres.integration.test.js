"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { Pool } = require("pg");
const { runMigrations } = require("../core/migrations");
const { observe } = require("../modules/price-monitor");

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  console.error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
  process.exit(1);
}

(async () => {
  const admin = new Pool({ connectionString });
  let pool;
  const schema = "price_observation_it_" + process.pid;
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
    assert.ok(migrationResult.files.includes("018_price_observation_consumer_price.sql"));

    const result = await observe({
      pool,
      message: {
        chatId: -1007654321,
        messageId: 9001,
        userId: 9002,
        text: "بيرل 9 ك: 505.31 | جملة 487.40 | مستهلك 525"
      },
      registry: []
    });
    assert.equal(result.saved, 1, "the real PostgreSQL database should accept one parsed observation");
    const id = result.savedRows[0].id;
    const stored = await pool.query(
      `SELECT package_sale_price, consumer_price, listed_base_price,
              explicit_wholesale_label_price, needs_review, weight_g,
              pack_count, package_type, decision
       FROM price_observations WHERE id=$1`,
      [id]
    );
    assert.equal(stored.rowCount, 1);
    const row = stored.rows[0];
    assert.equal(Number(row.package_sale_price), 487.40);
    assert.equal(Number(row.consumer_price), 525);
    assert.equal(Number(row.listed_base_price), 505.31);
    assert.equal(Number(row.explicit_wholesale_label_price), 487.40);
    assert.equal(row.needs_review, true);
    assert.equal(Number(row.weight_g), 9000);
    assert.equal(row.pack_count, null);
    assert.equal(row.package_type, null);
    assert.equal(row.decision, "pending");

    console.log("PRICE OBSERVATION POSTGRESQL INTEGRATION TESTS: OK");
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
