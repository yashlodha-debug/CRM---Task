/**
 * Central Postgres connection pool.
 * Every query in the app should go through this — never open ad-hoc connections.
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false } // required by Supabase/Neon free tier
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run a function inside a single transaction.
 * This is the backbone of the "never lose a session" guarantee -
 * status update + session open/close + history + sync_queue insert
 * all happen atomically, or not at all.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
