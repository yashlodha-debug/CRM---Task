# CRM Backend — Module 1: Database Layer

This is the first module of the build: schema + connection + migration tooling.
No API routes yet — that's the next module.

## What's in this module

- `db/migrations/001_init_schema.sql` — the full database schema described in the blueprint (users, permissions, tasks, status_sessions, status_history, login_sessions, break_logs, sync_queue, sync_log, task UID counter), plus seed data for your existing dropdown values and default permission keys.
- `db/migrate.js` — a tiny migration runner. Tracks what's been applied in a `schema_migrations` table, so it's safe to re-run.
- `db/seed-admin.js` — creates (or promotes) your first Master/Admin login.
- `src/db/pool.js` — the shared Postgres connection pool, including a `withTransaction()` helper. **This is the piece that guarantees a status change and its session record are written together or not at all** — every future write in the app will go through this.

## Setup (free tier)

1. Create a free Postgres database:
   - Go to [supabase.com](https://supabase.com) (or [neon.tech](https://neon.tech)) → New Project → free tier.
   - Copy the connection string (Supabase: Project Settings → Database → Connection string → URI).
2. Copy `.env.example` to `.env` and paste your connection string into `DATABASE_URL`. Set a random long string for `JWT_SECRET`.
3. Install dependencies:
   ```
   cd backend
   npm install
   ```
4. Run the migration:
   ```
   npm run migrate
   ```
   You should see `Applying migration: 001_init_schema.sql` then `success`.
5. Create your first Master/Admin login:
   ```
   node db/seed-admin.js admin YourStrongPassword123 "Your Name"
   ```

At this point you have a live, empty database with the full schema and your dropdown values pre-loaded — ready for the next module (Auth + Permissions API).

## Why the schema is designed this way (quick recap)

- **`status_sessions` has a partial unique index** (`idx_one_open_session_per_task`) that only allows one row with `end_time IS NULL` per task at the database level. This is what makes it *structurally impossible* to end up with two overlapping "Working On" sessions, or a session that silently never got closed — the exact failure mode from your old Duration Log.
- **`tasks.duration_seconds` is a cached total**, recalculated from `status_sessions` every time a transition happens (inside the same transaction) — so the app never needs to re-scan the whole session history on every read, and it also never drifts out of sync with the underlying sessions.
- **`user_permissions` + `permission_definitions`** are plain data, not code — adding a new permission or changing what a user can do never requires a deploy.
- **`sync_queue`** is written in the same transaction as the task change, so a Google Sheets outage can never cause a change to go unsynced — it just waits in the queue.

## Next module

Auth (login/logout, JWT issuance, password hashing) + the Permission middleware that enforces access **server-side** on every route. Let me know if you want any changes to this schema before I build on top of it — this is the easiest point to adjust it.
