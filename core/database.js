"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { redactString } = require("./diagnostics");

const TRANSIENT_CODES = new Set(["57P01", "57P02", "57P03", "08000", "08003", "08006", "08001", "08004", "53300", "40001", "40P01"]);

function isLocalDatabaseUrl(value) {
  return /\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i.test(String(value || ""));
}

function stripSslParams(rawUrl) {
  const value = String(rawUrl || "").trim();
  try {
    const u = new URL(value);
    for (const key of ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "sslnegotiation"]) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return value
      .replace(/([?&])(?:sslmode|ssl|sslcert|sslkey|sslrootcert|sslnegotiation)=[^&]*/gi, "$1")
      .replace(/[?&](?=&|$)/g, "")
      .replace(/[?&]$/, "");
  }
}

function buildPoolConfig(rawUrl = process.env.DATABASE_URL) {
  const value = String(rawUrl || "").trim();
  const forced = String(process.env.DATABASE_SSL || "").trim().toLowerCase();
  const local = isLocalDatabaseUrl(value) || forced === "disable" || forced === "false";
  return {
    connectionString: local ? value : stripSslParams(value),
    ssl: local ? false : { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_MAX || 8),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: "borsa-gpt-bot-v1",
  };
}

const url = String(process.env.DATABASE_URL || "").trim();
const hasDatabase = Boolean(url);
const pool = hasDatabase ? new Pool(buildPoolConfig(url)) : null;

if (pool) {
  pool.on("error", (err) => {
    console.error("[DB_POOL_ERROR]", redactString(err?.stack || err?.message || "database_pool_error"));
  });
}

function isTransientDbError(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|Connection terminated|server closed the connection|timeout expired/i.test(String(err.message || ""));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function query(sql, params = []) {
  if (!pool) throw new Error("DATABASE_URL غير مضبوط");
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await pool.query(sql, params); }
    catch (err) {
      last = err;
      if (!isTransientDbError(err) || attempt === 1) throw err;
      await sleep(400);
    }
  }
  throw last;
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

async function waitUntilReady({ attempts = 5, delayMs = 1500 } = {}) {
  if (!pool) throw new Error("DATABASE_URL غير مضبوط");
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      await pool.query("SELECT 1");
      return true;
    } catch (err) {
      last = err;
      console.warn(`[DB_CONNECT_RETRY] ${i + 1}/${attempts}: ${err.code || "NO_CODE"} ${redactString(err.message)}`);
      if (i + 1 < attempts) await sleep(delayMs * (i + 1));
    }
  }
  const failure = new Error(`تعذر الاتصال بقاعدة البيانات بعد ${attempts} محاولات: ${last?.code || ""} ${redactString(last?.message || "database_unreachable")}`);
  failure.code = last?.code;
  throw failure;
}

function splitSql(sql) {
  return String(sql || "")
    .split(/;\s*(?:\r?\n|$)/)
    .map((part) => part.replace(/--[^\n]*/g, "").trim())
    .filter(Boolean);
}

async function runMigrations(dir, files) {
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const statements = splitSql(sql);
    for (let i = 0; i < statements.length; i++) {
      try { await query(statements[i]); }
      catch (err) {
        const failure = new Error(`فشل ترحيل ${file} عند العبارة ${i + 1}: ${err.code || "NO_CODE"} ${redactString(err.message)}`);
        failure.code = err.code;
        throw failure;
      }
    }
  }
}

async function close() {
  if (pool) await pool.end();
}

module.exports = {
  pool,
  hasDatabase,
  query,
  withTransaction,
  close,
  buildPoolConfig,
  stripSslParams,
  isLocalDatabaseUrl,
  waitUntilReady,
  runMigrations,
  splitSql,
  isTransientDbError,
};
