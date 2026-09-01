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
  // Prevents an idle client error from crashing the whole process
  console.error('Unexpected error on idle Postgres client', err);
});

/**
 * Run a query with automatic client release.
 */
async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run a function inside a single transaction.
 * Usage:
 *   await withTransaction(async (client) => {
 *     await client.query('...');
 *   });
 *
 * This is the backbone of the "never lose a session" guarantee described
 * in the blueprint (section 6) — status update + session open/close +
 * history + sync_queue insert all happen atomically, or not at all.
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
