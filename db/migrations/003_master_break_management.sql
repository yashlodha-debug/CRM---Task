alter table login_sessions drop constraint login_sessions_logout_reason_check;

alter table login_sessions add constraint login_sessions_logout_reason_check
  check (logout_reason in ('manual', 'break_limit', 'day_end', 'expired', 'master_forced'));