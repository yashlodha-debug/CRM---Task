/**
 * Creates the first Master/Admin account.
 * Usage: node db/seed-admin.js <username> <password> <full_name>
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function run() {
  const [,, username, password, fullName] = process.argv;

  if (!username || !password) {
    console.error('Usage: node db/seed-admin.js <username> <password> <full_name>');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const existing = await pool.query('select id from users where username = $1', [username]);
  if (existing.rows.length > 0) {
    console.log(`User "${username}" already exists — updating role to master and resetting password.`);
    await pool.query(
      'update users set role = $1, password_hash = $2, is_active = true, updated_at = now() where username = $3',
      ['master', passwordHash, username]
    );
  } else {
    await pool.query(
      `insert into users (username, password_hash, full_name, role, is_active)
       values ($1, $2, $3, 'master', true)`,
      [username, passwordHash, fullName || username]
    );
    console.log(`Master user "${username}" created.`);
  }

  await pool.end();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
