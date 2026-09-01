-- ============================================================
-- Task Management CRM - Initial Schema
-- Target: PostgreSQL 14+ (Supabase / Neon compatible)
-- Timezone convention: all timestamps stored as timestamptz (UTC),
-- converted to Asia/Kolkata (IST) at the application/display layer.
-- ============================================================

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. USERS
-- ------------------------------------------------------------
create table users (
    id              uuid primary key default gen_random_uuid(),
    username        text not null unique,
    password_hash   text not null,
    full_name       text not null,
    role            text not null check (role in ('master','user')),
    is_active       boolean not null default true,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index idx_users_username on users (username);

-- ------------------------------------------------------------
-- 2. PERMISSION DEFINITIONS (master list, admin-editable)
-- ------------------------------------------------------------
create table permission_definitions (
    id          uuid primary key default gen_random_uuid(),
    key         text not null unique,   -- e.g. 'create_task'
    label       text not null,          -- e.g. 'Create Task'
    description text,
    created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3. USER PERMISSIONS (join table - flexible, no code changes needed)
-- ------------------------------------------------------------
create table user_permissions (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid not null references users(id) on delete cascade,
    permission_key    text not null references permission_definitions(key) on delete cascade,
    enabled           boolean not null default false,
    updated_at        timestamptz not null default now(),
    updated_by        uuid references users(id),
    unique (user_id, permission_key)
);

create index idx_user_permissions_user on user_permissions (user_id);

-- ------------------------------------------------------------
-- 4. DROPDOWN OPTIONS (admin-configurable master data)
-- ------------------------------------------------------------
create table dropdown_options (
    id          uuid primary key default gen_random_uuid(),
    field_name  text not null,   -- 'assigned' | 'task' | 'related_to' | 'exis_data' | 'status' | 'dashboard_status'
    value       text not null,
    sort_order  int not null default 0,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now(),
    unique (field_name, value)
);

create index idx_dropdown_field on dropdown_options (field_name);

-- ------------------------------------------------------------
-- 5. TASKS
-- ------------------------------------------------------------
create table tasks (
    id                  uuid primary key default gen_random_uuid(),
    task_uid            text not null unique,          -- TASK-YYYYMMDD-NNNN
    mail_date           date,
    assign_date         date,
    assigned_user_id    uuid references users(id),
    task_type           text,                           -- Purchase / POC Standard / Client Standard / Inventory
    related_to          text,                           -- Recipe & Material / Rework / Raw material / Other
    exis_data           text,                           -- Yes / No
    rest_id             text,
    rest_name           text,
    email_subject       text,
    recipes_count       int,
    raw_count           int,
    status              text not null default 'Open',
    dashboard_status    text,
    start_time          timestamptz,                    -- first time task entered Working On
    end_time            timestamptz,                    -- last time task left Working On
    duration_seconds    int not null default 0,         -- cached total, recalculated on every transition
    last_comment        text,
    suggested           text,
    sla                 text,
    created_by          uuid references users(id),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index idx_tasks_assigned_user on tasks (assigned_user_id);
create index idx_tasks_status on tasks (status);
create index idx_tasks_task_uid on tasks (task_uid);
-- Supports global search across key text fields
create index idx_tasks_search on tasks using gin (
    to_tsvector('simple',
        coalesce(task_uid,'') || ' ' || coalesce(rest_id,'') || ' ' || coalesce(rest_name,'') || ' ' ||
        coalesce(email_subject,'') || ' ' || coalesce(task_type,'') || ' ' || coalesce(related_to,'')
    )
);

-- ------------------------------------------------------------
-- 6. STATUS_SESSIONS (the core time-tracking fix)
-- Logs every status interval. Duration totals are computed only
-- from rows where status = 'Working On'.
-- ------------------------------------------------------------
create table status_sessions (
    id                uuid primary key default gen_random_uuid(),
    task_id           uuid not null references tasks(id) on delete cascade,
    task_uid          text not null,          -- denormalized for fast lookups
    user_id           uuid references users(id),
    status            text not null,
    start_time        timestamptz not null default now(),
    end_time          timestamptz,            -- NULL = currently open/active interval
    duration_seconds  int,
    created_at        timestamptz not null default now()
);

create index idx_status_sessions_task on status_sessions (task_id);
create index idx_status_sessions_task_uid on status_sessions (task_uid);

-- CRITICAL CONSTRAINT: only one open (end_time IS NULL) session per task.
-- This makes duplicate/overlapping "Working On" sessions impossible
-- at the database level - the root cause of the old Duration Log bug.
create unique index idx_one_open_session_per_task
    on status_sessions (task_id)
    where (end_time is null);

-- ------------------------------------------------------------
-- 7. STATUS_HISTORY (append-only comment/audit trail)
-- ------------------------------------------------------------
create table status_history (
    id                uuid primary key default gen_random_uuid(),
    task_id           uuid not null references tasks(id) on delete cascade,
    task_uid          text not null,
    user_id           uuid references users(id),
    previous_status   text,
    new_status        text not null,
    comment           text not null,
    changed_at        timestamptz not null default now()
);

create index idx_status_history_task on status_history (task_id);

-- ------------------------------------------------------------
-- 8. LOGIN_SESSIONS
-- ------------------------------------------------------------
create table login_sessions (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references users(id),
    login_time          timestamptz not null default now(),
    logout_time         timestamptz,
    logout_reason       text check (logout_reason in ('manual','break_limit','day_end','expired')),
    session_token_hash  text not null,
    ip_address          text,
    login_date_ist      date not null            -- calendar day (IST) this session belongs to, for break/logout resets
);

create index idx_login_sessions_user on login_sessions (user_id);
create index idx_login_sessions_open on login_sessions (user_id) where (logout_time is null);

-- ------------------------------------------------------------
-- 9. BREAK_LOGS
-- ------------------------------------------------------------
create table break_logs (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references users(id),
    login_session_id    uuid not null references login_sessions(id) on delete cascade,
    break_type          text not null check (break_type in ('lunch','tea','short')),
    break_start         timestamptz not null default now(),
    break_end           timestamptz,             -- NULL while on break
    duration_seconds    int,
    date_ist            date not null
);

create index idx_break_logs_session on break_logs (login_session_id);
create unique index idx_one_open_break_per_session
    on break_logs (login_session_id)
    where (break_end is null);

-- ------------------------------------------------------------
-- 10. SYNC_QUEUE (Google Sheet live sync)
-- ------------------------------------------------------------
create table sync_queue (
    id              uuid primary key default gen_random_uuid(),
    entity_type     text not null default 'task',
    entity_id       uuid not null,
    task_uid        text not null,
    action          text not null check (action in ('insert','update')),
    payload         jsonb not null,
    status          text not null default 'pending' check (status in ('pending','processing','success','failed')),
    attempts        int not null default 0,
    last_error      text,
    created_at      timestamptz not null default now(),
    processed_at    timestamptz
);

create index idx_sync_queue_status on sync_queue (status);

-- ------------------------------------------------------------
-- 11. SYNC_LOG (audit trail of sheet writes)
-- ------------------------------------------------------------
create table sync_log (
    id              uuid primary key default gen_random_uuid(),
    sync_queue_id   uuid references sync_queue(id) on delete set null,
    result          text not null check (result in ('success','failed')),
    response_snippet text,
    synced_at       timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 12. TASK_UID_COUNTER (safe unique UID generation, no race conditions)
-- One row per calendar date, incremented atomically.
-- ------------------------------------------------------------
create table task_uid_counters (
    date_key    text primary key,   -- 'YYYYMMDD' in IST
    last_seq    int not null default 0
);

-- ------------------------------------------------------------
-- Seed: default permission definitions
-- ------------------------------------------------------------
insert into permission_definitions (key, label) values
    ('view_my_tasks', 'View My Tasks'),
    ('view_team_tasks', 'View Team Tasks'),
    ('change_status', 'Change Status'),
    ('add_comment', 'Add Comment'),
    ('edit_comment', 'Edit Comment'),
    ('edit_task_details', 'Edit Task Details'),
    ('change_assigned', 'Change Assigned'),
    ('reassign_task', 'Reassign Task'),
    ('change_dashboard_status', 'Change Dashboard Status'),
    ('create_task', 'Create Task'),
    ('delete_task', 'Delete Task');

-- ------------------------------------------------------------
-- Seed: default dropdown options (from your existing sheet)
-- ------------------------------------------------------------
insert into dropdown_options (field_name, value, sort_order) values
    ('assigned','Nikita',1),('assigned','Prashant',2),('assigned','Gaurav',3),
    ('assigned','Nilanjali',4),('assigned','Prachi',5),('assigned','Bhumika',6),
    ('assigned','Prashant R',7),('assigned','Tushar',8),('assigned','Gunjan',9),
    ('assigned','Priya',10),('assigned','Krisha',11),

    ('task','Purchase',1),('task','POC Standard',2),('task','Client Standard',3),('task','Inventory',4),

    ('related_to','Recipe & Material',1),('related_to','Rework',2),
    ('related_to','Raw material',3),('related_to','Other',4),

    ('exis_data','Yes',1),('exis_data','No',2),

    ('status','Open',1),('status','Assigned',2),('status','Working On',3),
    ('status','Pending',4),('status','Hold',5),('status','Priority',6),
    ('status','For Next Day',7),('status','Done',8),('status','Close',9),

    ('dashboard_status','Done',1),('dashboard_status','Client side hold',2),
    ('dashboard_status','Close',3),('dashboard_status','Under Process',4);
