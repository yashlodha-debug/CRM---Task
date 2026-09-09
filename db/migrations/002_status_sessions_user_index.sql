-- ==================================================================
-- Performance: status_sessions had no index on user_id, so the new
-- "Total working time (all tasks)" query (and any future per-user
-- session lookup) does a full table scan. This table grows by one
-- row on every status change across every task, so it will only get
-- slower over time without this.
-- ==================================================================

create index if not exists idx_status_sessions_user_status_start
  on status_sessions (user_id, status, start_time);

-- break_logs is filtered by (user_id, date_ist) on every dashboard poll
-- (every 30s per active user) and every break start/stop, but only had
-- an index on login_session_id.
create index if not exists idx_break_logs_user_date
  on break_logs (user_id, date_ist);