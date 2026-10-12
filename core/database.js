"use strict";

const { Pool } = require("pg");

const url = String(process.env.DATABASE_URL || "").trim();
const hasDatabase = Boolean(url);

const pool = hasDatabase
  ? new Pool({
      connectionString: url,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
      max: Number(process.env.DB_POOL_MAX || 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    })
  : null;

if (pool) {
  pool.on("error", (err) => {
    console.error("[DB_POOL_ERROR]", err?.stack || err);
  });
}

async function query(sql, params = []) {
  if (!pool) throw new Error("DATABASE_URL غير مضبوط");
  return pool.query(sql, params);
}

async function withTransaction(fn) {
  if (!pool) throw new Error("DATABASE_URL غير مضبوط");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) await pool.end();
}

module.exports = { pool, hasDatabase, query, withTransaction, close };
