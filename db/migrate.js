/**
 * Very small migration runner: applies any .sql file in db/migrations
 * that hasn't been applied yet, in filename order. Tracks progress in
 * a `schema_migrations` table so re-running is safe.
 *
 * Usage: npm run migrate
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function ensureMigrationsTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
  `);
}

async function run() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);

    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

    const { rows: applied } = await client.query('select filename from schema_migrations');
    const appliedSet = new Set(applied.map(r => r.filename));

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`Skipping already-applied migration: ${file}`);
        continue;
      }
      console.log(`Applying migration: ${file}`);
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  -> success`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  -> FAILED:`, err.message);
        process.exit(1);
      }
    }

    console.log('All migrations up to date.');
  } finally {
    client.release();
    await pool.end();
  }
}

run();
