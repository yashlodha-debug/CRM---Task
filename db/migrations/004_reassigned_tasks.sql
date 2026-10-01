-- ==================================================================
-- Reassigned task tracking.
-- A task created through the "Reassign Task" option is a brand-new,
-- separate task. These columns only LABEL it so the CRM and the Google
-- Sheet can highlight it and the Team Today's Activity table can count
-- it. The original task row is never modified.
-- ==================================================================

alter table tasks
  add column if not exists is_reassigned boolean not null default false;

alter table tasks
  add column if not exists reassigned_from_task_uid text;

-- Used by the Team Today's Activity "Reassigned" count.
create index if not exists idx_tasks_reassigned_assign_date
  on tasks (assign_date, assigned_user_id)
  where is_reassigned = true;

-- Backfill: tasks that were already created via Reassign before this
-- update are identifiable from the history line reassignTask() wrote
-- ("Reassigned from TASK-YYYYMMDD-NNNN.").
update tasks t
set is_reassigned = true,
    reassigned_from_task_uid = substring(sh.comment from 'Reassigned from (TASK-[0-9]+-[0-9]+)')
from status_history sh
where sh.task_id = t.id
  and sh.comment like 'Reassigned from TASK-%'
  and t.is_reassigned = false;
