const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err, client) => {
  console.error('[Database Error]: Unexpected error on idle PostgreSQL client', err);
});

async function query(text, params) {
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (error) {
    console.error('[Database Query Error]:', { text, error: error.message });
    throw error;
  }
}

module.exports = {
  query,
  pool
};
