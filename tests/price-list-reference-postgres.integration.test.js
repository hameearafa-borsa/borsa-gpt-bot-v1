"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { runMigrations } = require("../core/migrations");
const { deterministicList, parseListMetadata } = require("../modules/price-list");
const { persistPriceList } = require("../modules/price-list-persistence");
const { compareObservationToLatestReference, compareReferencePrice } = require("../modules/price-reference-comparison");

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  console.error("TEST_DATABASE_URL is required for PostgreSQL price-list persistence integration tests");
  process.exit(1);
}

(async () => {
  const admin = new Pool({ connectionString });
  let pool;
  const schema = "unilever_list_it_" + process.pid;
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

    await runMigrations({ db, rootDir: path.join(__dirname, "..") });
    const sourceText = fs.readFileSync(path.join(__dirname, "fixtures-unilever-oct-2026.txt"), "utf8");
    const parsedList = parseListMetadata(sourceText);
    const rows = deterministicList(sourceText);
    assert.equal(parsedList.company, "شركة يونيليفر");
    assert.equal(parsedList.month, "أكتوبر 2026");
    assert.equal(parsedList.priceType, "أسعار جملة");
    assert.equal(rows.length, 66);
    assert.equal(rows.filter(row => row.decision === "accepted").length, 66);

    const result = await db.withTransaction(client => persistPriceList(client, {
      message: { chatId: -1001234567890, messageId: 987654 },
      sourceText,
      parsedList,
      rows
    }));
    assert.deepEqual(result, { runId: result.runId, extracted: 66, accepted: 66, referenceKind: "wholesale" });

    const run = await pool.query(
      "SELECT source_chat_id, source_message_id, status, extracted_count, accepted_count, skipped_count FROM price_list_runs WHERE id=$1",
      [result.runId]
    );
    assert.equal(run.rowCount, 1);
    assert.equal(run.rows[0].status, "processed");
    assert.equal(run.rows[0].extracted_count, 66);
    assert.equal(run.rows[0].accepted_count, 66);
    assert.equal(run.rows[0].skipped_count, 0);

    const catalog = await pool.query(
      "SELECT COUNT(*)::int AS count FROM price_list_items WHERE run_id=$1",
      [result.runId]
    );
    const references = await pool.query(
      `SELECT company_label, source_period, declared_price_type, price_kind, product_label,
              package_sale_price, unit_price_type, raw_line, decision
       FROM price_reference_observations WHERE run_id=$1 ORDER BY id`,
      [result.runId]
    );
    const liveObservations = await pool.query("SELECT COUNT(*)::int AS count FROM price_observations");
    assert.equal(catalog.rows[0].count, 66, "all parsed rows must persist in the company catalog");
    assert.equal(references.rowCount, 66, "all accepted company rows must persist as official references");
    assert.equal(liveObservations.rows[0].count, 0, "official list rows must not be mixed into live group observations");
    assert.ok(references.rows.every(row =>
      row.company_label === "شركة يونيليفر" &&
      row.source_period === "أكتوبر 2026" &&
      row.declared_price_type === "أسعار جملة" &&
      row.price_kind === "wholesale" &&
      row.decision === "accepted"
    ));

    const signal = references.rows.find(row => /سيجنال 120مل/.test(row.raw_line || ""));
    assert.ok(signal, "the Signal 120 ml row must be persisted");
    assert.equal(Number(signal.package_sale_price), 42.33);
    assert.equal(signal.unit_price_type, "بالقطعة");

    const carton = references.rows.find(row => /كلير أكياس 5 مل الكرتونة/.test(row.raw_line || ""));
    assert.ok(carton, "the explicit Clear sachet carton row must be persisted");
    assert.equal(Number(carton.package_sale_price), 346);
    assert.equal(carton.unit_price_type, "بالكرتونة");

    const bonus = references.rows.find(row => /سيجنال قرنفل 100مل \+25مل هدية/.test(row.raw_line || ""));
    assert.ok(bonus, "the Signal bonus quantity must remain visible in the original row");
    assert.equal(bonus.unit_price_type, "بالقطعة");

    const cartonGift = references.rows.find(row => /كامي 110جم/.test(row.raw_line || ""));
    assert.ok(cartonGift && /العرض على الكرتونة قطعة صابون هدية/.test(cartonGift.raw_line));
    assert.equal(cartonGift.unit_price_type, "بالكرتونة");

    // Exercise the actual PostgreSQL reference lookup and strict comparison path,
    // not just the pure comparator with mocked reference rows.
    const signalComparison = await compareObservationToLatestReference(pool, {
      price_kind: "wholesale",
      product_text: "سيجنال",
      weight_g: null,
      volume_ml: 120,
      package_sale_price: 45,
      pack_count: null,
      offer_extra_weight_g: null,
      unit_price_type: "بالقطعة"
    });
    assert.equal(signalComparison.comparable, true,
      "a matching Signal 120 ml per-piece wholesale observation should match the real saved reference");
    assert.equal(signalComparison.referencePrice, 42.33);
    assert.equal(signalComparison.observedPrice, 45);
    assert.equal(signalComparison.difference, 2.67);
    assert.equal(signalComparison.sourcePeriod, "أكتوبر 2026");

    const bonusReference = references.rows.find(row => /سيجنال قرنفل 100مل \+25مل هدية/.test(row.raw_line || ""));
    assert.equal(compareReferencePrice(bonusReference, {
      price_kind: "wholesale",
      product_text: bonusReference.product_label,
      weight_g: bonusReference.weight_g == null ? null : Number(bonusReference.weight_g),
      volume_ml: bonusReference.volume_ml == null ? null : Number(bonusReference.volume_ml),
      package_sale_price: Number(bonusReference.package_sale_price),
      pack_count: bonusReference.pack_count == null ? null : Number(bonusReference.pack_count),
      offer_extra_weight_g: null,
      unit_price_type: bonusReference.unit_price_type
    }).reason, "reference_offer_needs_structured_metadata",
    "the real saved +25 ml promotion must not be treated as a base product price");

    const cartonComparison = await compareObservationToLatestReference(pool, {
      price_kind: "wholesale",
      product_text: "كلير أكياس 5 مل",
      weight_g: null,
      volume_ml: 5,
      package_sale_price: 360,
      pack_count: null,
      offer_extra_weight_g: null,
      unit_price_type: "بالكرتونة"
    });
    assert.equal(cartonComparison.comparable, false,
      "a carton observation with unknown pack count must not compare with a company carton reference");
    assert.equal(cartonComparison.reason, "carton_count_mismatch_or_unknown");

    console.log("UNILEVER PRICE-LIST POSTGRESQL INTEGRATION TEST: OK (66 catalog rows, 66 official references, real comparison lookup, no live observations)");
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
