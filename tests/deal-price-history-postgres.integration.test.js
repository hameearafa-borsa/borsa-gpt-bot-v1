"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { Pool } = require("pg");
const { runMigrations } = require("../core/migrations");
const { persistDeals } = require("../modules/deal-scheduler");

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  console.error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
  process.exit(1);
}

(async () => {
  const admin = new Pool({ connectionString });
  let pool;
  const schema = "deal_price_history_it_" + process.pid;
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
    assert.ok(migrationResult.files.includes("005_deal_product_identity.sql"));
    assert.ok(migrationResult.files.includes("032_deal_publication_queue.sql"));
    assert.ok(migrationResult.files.includes("033_deal_observed_price_history.sql"));

    const product = {
      merchant: "Amazon.eg",
      title: "Boum Butter Hair Repair Shampoo Set",
      url: "https://www.amazon.eg/dp/B0HL6J6R1X",
      category: "personal_care",
      old_price: null,
      discount_pct: 0
    };

    assert.equal(await persistDeals(pool, [{ ...product, price: 499 }]), 1);
    let rows = await pool.query(
      "SELECT price,old_price,discount_pct,previous_observed_price,price_change_pct FROM deal_observations"
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(Number(rows.rows[0].price), 499);
    assert.equal(rows.rows[0].previous_observed_price, null);
    assert.equal(rows.rows[0].price_change_pct, null);
    assert.equal(rows.rows[0].old_price, null);
    assert.equal(Number(rows.rows[0].discount_pct), 0);

    assert.equal(await persistDeals(pool, [{ ...product, price: 449 }]), 1);
    rows = await pool.query(
      "SELECT price,old_price,discount_pct,previous_observed_price,price_change_pct FROM deal_observations ORDER BY id"
    );
    assert.equal(rows.rowCount, 2);
    const lower = rows.rows.find(row => Number(row.price) === 449);
    assert.ok(lower);
    assert.equal(Number(lower.previous_observed_price), 499);
    assert.equal(Number(lower.price_change_pct), -10.02);
    assert.equal(lower.old_price, null, "historical price must not be copied into retailer old_price");
    assert.equal(Number(lower.discount_pct), 0, "historical movement must not become a retailer discount");

    // Re-observing the same price updates its observation without losing the prior different price.
    assert.equal(await persistDeals(pool, [{ ...product, price: 449 }]), 1);
    rows = await pool.query(
      "SELECT price,previous_observed_price,price_change_pct FROM deal_observations WHERE price=449"
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(Number(rows.rows[0].previous_observed_price), 499);
    assert.equal(Number(rows.rows[0].price_change_pct), -10.02);

    // If the product price rises back, the last different observation is 449.
    assert.equal(await persistDeals(pool, [{ ...product, price: 499 }]), 1);
    rows = await pool.query(
      "SELECT price,previous_observed_price,price_change_pct FROM deal_observations WHERE price=499"
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(Number(rows.rows[0].previous_observed_price), 449);
    assert.equal(Number(rows.rows[0].price_change_pct), 11.14);

    console.log("DEAL PRICE HISTORY POSTGRESQL INTEGRATION TESTS: OK");
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
