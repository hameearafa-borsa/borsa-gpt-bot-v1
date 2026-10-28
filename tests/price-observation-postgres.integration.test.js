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
    assert.ok(migrationResult.files.includes("019_reviewed_product_pack_identity.sql"));
    const memoryColumns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='reviewed_price_products'",
      [schema]
    );
    assert.ok(memoryColumns.rows.some(row => row.column_name === "package_type"));
    assert.ok(memoryColumns.rows.some(row => row.column_name === "offer_extra_weight_g"));

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


    // Full Pearl October catalog: verify all thirteen parsed rows and distinct
    // wholesale/base/consumer fields survive a real PostgreSQL write.
    const pearlText = `أسعار بيرل – أكتوبر
..... أوتوماتيك
• 9 ك: 505.31 | جملة 487.40 | مستهلك 525
• 5 ك: 308.43 | جملة 915.87 | مستهلك 325
• 2.5 ك: 179.15 | جملة 716.63 | مستهلك 200
..... أوزان وشكاير
• شكارة 10 ك: 618.35 | مستهلك 630
• شكارة 7 ك: 432.84 | مستهلك 450
• 2 ك: 129.22 | جملة 516.90 | مستهلك 145
• 1.5 ك: 98.96 | جملة 395.85 | مستهلك 110
• 1 ك: 66.28 | جملة 265.15 | مستهلك 75
.. العبوات الصغيرة
• 290 جم: 22.03 | جملة 176.29 | مستهلك 25
• 160 جم: 12 | جملة 144.06 | مستهلك 15
• 120 جم: 8.46 | جملة 135.49 | مستهلك 10
• 50 جم: 3.96 | جملة 47.52 | مستهلك 5
• 30 جم: 3.79 | جملة 75.95 | مستهلك 5`;
    const pearl = await observe({
      pool,
      message: { chatId: -1007654321, messageId: 9003, userId: 9002, text: pearlText },
      registry: []
    });
    assert.equal(pearl.saved, 13, "all thirteen Pearl rows must be persisted in PostgreSQL");
    assert.deepEqual(pearl.savedRows.map(item => item.row.package_sale_price), [
      487.40, 915.87, 716.63, 618.35, 432.84, 516.90, 395.85, 265.15,
      176.29, 144.06, 135.49, 47.52, 75.95
    ], "stored package_sale_price must always be the labelled wholesale price, or the only non-consumer price");
    const pearlStored = await pool.query(
      `SELECT package_sale_price, consumer_price, listed_base_price,
              explicit_wholesale_label_price, weight_g, pack_count, package_type, decision
       FROM price_observations WHERE source_chat_id=$1 AND source_message_id=$2 ORDER BY id ASC`,
      [-1007654321, 9003]
    );
    assert.equal(pearlStored.rowCount, 13);
    assert.deepEqual(pearlStored.rows.map(row => Number(row.package_sale_price)), [
      487.40, 915.87, 716.63, 618.35, 432.84, 516.90, 395.85, 265.15,
      176.29, 144.06, 135.49, 47.52, 75.95
    ]);
    assert.deepEqual(pearlStored.rows.map(row => row.consumer_price == null ? null : Number(row.consumer_price)), [
      525, 325, 200, 630, 450, 145, 110, 75, 25, 15, 10, 5, 5
    ], "consumer prices must remain in their own database column");
    assert.deepEqual(pearlStored.rows.slice(0, 3).map(row => Number(row.listed_base_price)), [505.31, 308.43, 179.15]);
    assert.deepEqual(pearlStored.rows.slice(0, 3).map(row => Number(row.explicit_wholesale_label_price)), [487.40, 915.87, 716.63]);
    assert.deepEqual(pearlStored.rows.map(row => Number(row.weight_g)), [
      9000, 5000, 2500, 10000, 7000, 2000, 1500, 1000, 290, 160, 120, 50, 30
    ]);
    assert.deepEqual(pearlStored.rows.slice(3, 5).map(row => row.package_type), ["sack", "sack"]);
    assert.deepEqual(pearlStored.rows.slice(3, 5).map(row => row.pack_count), [null, null],
      "unknown sack unit counts must remain SQL NULL rather than being invented");
    assert.ok(pearlStored.rows.every(row => row.decision === "pending"),
      "new catalog identities must be saved for review rather than auto-approved");

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
