/**
 * Task service - all task business logic lives here, kept separate from
 * the HTTP route handlers so it's easy to test and reuse.
 */
const { query, withTransaction } = require('../db/pool');
const { generateTaskUid } = require('../utils/taskUid');
const { todayIST } = require('../utils/date');

const WORKING_STATUS = 'Working On';

/**
 * Creates a new task. Runs the UID generation and the task insert inside
 * one transaction so a crash between the two can never leave a "gap" or
 * a task without a UID.
 */
async function createTask(data, createdByUserId, createdByRole) {
  if (!data.taskType || !data.relatedTo || !data.assignedUserId) {
    throw Object.assign(
      new Error('Task, Related To, and Assigned are required.'),
      { statusCode: 400 }
    );
  }
  if (!data.restId || !String(data.restId).trim()) {
    throw Object.assign(
      new Error('RID is required.'),
      { statusCode: 400 }
    );
  }
  // Master creates/assigns tasks on behalf of the team and may not have an
  // email subject on hand yet - only regular users are required to supply one.
  if (createdByRole !== 'master' && (!data.emailSubject || !String(data.emailSubject).trim())) {
    throw Object.assign(
      new Error('Email Subject is required.'),
      { statusCode: 400 }
    );
  }

  return withTransaction(async (client) => {
    const taskUid = await generateTaskUid(client);
    const initialStatus = data.status || 'Open';
    // Mail date and Assign date default to today (IST) if not explicitly provided.
    const mailDate = data.mailDate || todayIST();
    const assignDate = data.assignDate || todayIST();

    const { rows } = await client.query(
      `insert into tasks (
         task_uid, mail_date, assign_date, assigned_user_id, task_type,
         related_to, exis_data, rest_id, rest_name, email_subject,
         recipes_count, raw_count, status, dashboard_status,
         suggested, sla, created_by
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
       ) returning *`,
      [
        taskUid,
        mailDate,
        assignDate,
        data.assignedUserId || null,
        data.taskType || null,
        data.relatedTo || null,
        data.exisData || null,
        data.restId || null,
        data.restName || null,
        data.emailSubject || null,
        data.recipesCount || null,
        data.rawCount || null,
        initialStatus,
        data.dashboardStatus || null,
        data.suggested || null,
        data.sla || null,
        createdByUserId
      ]
    );

    const task = rows[0];

    // If the task is created directly in "Working On", open its first session.
    if (initialStatus === WORKING_STATUS) {
      await client.query(
        `insert into status_sessions (task_id, task_uid, user_id, status, start_time)
         values ($1, $2, $3, $4, now())`,
        [task.id, task.task_uid, data.assignedUserId || null, WORKING_STATUS]
      );
    }

    await client.query(
      `insert into status_history (task_id, task_uid, user_id, previous_status, new_status, comment)
       values ($1, $2, $3, null, $4, $5)`,
      [task.id, task.task_uid, createdByUserId, initialStatus, 'Task created.']
    );

    await enqueueSync(client, task.id, task.task_uid, 'insert', task);

    return task;
  });
}

/**
 * The core "never lose a session" logic (blueprint section 6/16).
 * Changes a task's status, closing/opening status_sessions rows and
 * recording status_history, all inside one atomic transaction.
 */
async function changeStatus(taskId, newStatus, comment, userId) {
  if (!comment || !comment.trim()) {
    throw Object.assign(new Error('A comment is required when changing status.'), { statusCode: 400 });
  }

  return withTransaction(async (client) => {
    // Lock the task row so two simultaneous status changes on the same
    // task can't race each other and create overlapping sessions.
    const { rows: taskRows } = await client.query(
      `select * from tasks where id = $1 for update`,
      [taskId]
    );
    const task = taskRows[0];
    if (!task) {
      throw Object.assign(new Error('Task not found.'), { statusCode: 404 });
    }

    const previousStatus = task.status;

    // Close the currently open session, if the task is leaving "Working On"
    if (previousStatus === WORKING_STATUS && newStatus !== WORKING_STATUS) {
      await client.query(
        `update status_sessions
         set end_time = now(),
             duration_seconds = extract(epoch from (now() - start_time))::int
         where task_id = $1 and end_time is null`,
        [taskId]
      );
    }

    // Open a new session if the task is entering "Working On"
    if (newStatus === WORKING_STATUS && previousStatus !== WORKING_STATUS) {
      await client.query(
        `insert into status_sessions (task_id, task_uid, user_id, status, start_time)
         values ($1, $2, $3, $4, now())`,
        [taskId, task.task_uid, userId, WORKING_STATUS]
      );
    }

    // Recompute the cached total from the sessions themselves - this is
    // always derived, never hand-edited, so it can't drift out of sync.
    const { rows: durationRows } = await client.query(
      `select coalesce(sum(duration_seconds), 0) as total
       from status_sessions
       where task_id = $1 and status = $2 and end_time is not null`,
      [taskId, WORKING_STATUS]
    );
    const totalDuration = durationRows[0].total;

    const { rows: updatedRows } = await client.query(
      `update tasks
       set status = $1,
           duration_seconds = $2,
           start_time = coalesce(start_time, case when $1 = $3 then now() else start_time end),
           end_time = case when $1 != $3 then now() else end_time end,
           last_comment = $4,
           updated_at = now()
       where id = $5
       returning *`,
      [newStatus, totalDuration, WORKING_STATUS, comment, taskId]
    );
    const updatedTask = updatedRows[0];

    await client.query(
      `insert into status_history (task_id, task_uid, user_id, previous_status, new_status, comment)
       values ($1, $2, $3, $4, $5, $6)`,
      [taskId, task.task_uid, userId, previousStatus, newStatus, comment]
    );

    await enqueueSync(client, taskId, task.task_uid, 'update', updatedTask);

    return updatedTask;
  });
}

async function updateDashboardStatus(taskId, dashboardStatus, userId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `update tasks set dashboard_status = $1, updated_at = now() where id = $2 returning *`,
      [dashboardStatus, taskId]
    );
    const task = rows[0];
    if (!task) {
      throw Object.assign(new Error('Task not found.'), { statusCode: 404 });
    }
    await enqueueSync(client, taskId, task.task_uid, 'update', task);
    return task;
  });
}

/**
 * Item 2: general task detail edit - everything EXCEPT status and
 * assignment, which have their own dedicated, more carefully-controlled
 * functions (changeStatus / reassignTask) since those touch time-tracking
 * sessions. Only fields actually provided in `updates` are changed.
 */
const EDITABLE_FIELDS = [
  'mailDate', 'assignDate', 'taskType', 'relatedTo', 'exisData', 'restId',
  'restName', 'emailSubject', 'recipesCount', 'rawCount', 'suggested', 'sla'
];
const FIELD_TO_COLUMN = {
  mailDate: 'mail_date', assignDate: 'assign_date', taskType: 'task_type',
  relatedTo: 'related_to', exisData: 'exis_data', restId: 'rest_id',
  restName: 'rest_name', emailSubject: 'email_subject', recipesCount: 'recipes_count',
  rawCount: 'raw_count', suggested: 'suggested', sla: 'sla'
};

async function updateTaskDetails(taskId, updates, userId, userRole) {
  const providedFields = EDITABLE_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(updates, f));
  if (providedFields.length === 0) {
    throw Object.assign(new Error('No editable fields were provided.'), { statusCode: 400 });
  }
  // Item 3: Rest ID stays compulsory whenever it's part of the edit; Email
  // Subject follows the same Master exception used at task creation.
  if (providedFields.includes('restId') && (!updates.restId || !String(updates.restId).trim())) {
    throw Object.assign(new Error('Rest ID is required.'), { statusCode: 400 });
  }
  if (
    providedFields.includes('emailSubject') &&
    userRole !== 'master' &&
    (!updates.emailSubject || !String(updates.emailSubject).trim())
  ) {
    throw Object.assign(new Error('Email Subject is required.'), { statusCode: 400 });
  }

  return withTransaction(async (client) => {
    const setClauses = providedFields.map((f, i) => `${FIELD_TO_COLUMN[f]} = $${i + 1}`);
    const values = providedFields.map((f) => updates[f]);

    const { rows } = await client.query(
      `update tasks set ${setClauses.join(', ')}, updated_at = now()
       where id = $${providedFields.length + 1}
       returning *`,
      [...values, taskId]
    );
    const task = rows[0];
    if (!task) {
      throw Object.assign(new Error('Task not found.'), { statusCode: 404 });
    }

    await client.query(
      `insert into status_history (task_id, task_uid, user_id, previous_status, new_status, comment)
       values ($1, $2, $3, $4, $4, $5)`,
      [taskId, task.task_uid, userId, task.status, 'Task details edited.']
    );

    await enqueueSync(client, taskId, task.task_uid, 'update', task);
    return task;
  });
}

/**
 * Item 2: "Reassign" a task by creating a brand-new task from the old
 * one's details, rather than editing the old task in place. This matches
 * the real workflow: a completed task's client comes back with a follow
 * up request, and the old task (its original Assign Date, status,
 * duration, history) must stay exactly as it was for reporting purposes.
 *
 * The old task is only ever SELECTed here, never updated - reusing
 * createTask() guarantees the new task gets its own fresh Task UID and
 * is synced to the Sheet as a new 'insert' row, so nothing about the old
 * task's row is touched or overwritten. Any field the caller doesn't
 * explicitly override falls back to the old task's current value, and
 * Assign Date is always set to today for the new task regardless.
 */
async function reassignTask(oldTaskId, newAssignedUserId, userId, userRole, comment, fieldUpdates = {}) {
  if (!newAssignedUserId) {
    throw Object.assign(new Error('newAssignedUserId is required.'), { statusCode: 400 });
  }

  const { rows } = await query(`select * from tasks where id = $1`, [oldTaskId]);
  const oldTask = rows[0];
  if (!oldTask) {
    throw Object.assign(new Error('Task not found.'), { statusCode: 404 });
  }

  const pick = (key, column) =>
    Object.prototype.hasOwnProperty.call(fieldUpdates, key) ? fieldUpdates[key] : oldTask[column];

  const newTask = await createTask(
    {
      assignedUserId: newAssignedUserId,
      taskType: pick('taskType', 'task_type'),
      relatedTo: pick('relatedTo', 'related_to'),
      exisData: pick('exisData', 'exis_data'),
      restId: pick('restId', 'rest_id'),
      restName: pick('restName', 'rest_name'),
      emailSubject: pick('emailSubject', 'email_subject'),
      recipesCount: pick('recipesCount', 'recipes_count'),
      rawCount: pick('rawCount', 'raw_count'),
      mailDate: pick('mailDate', 'mail_date'),
      assignDate: todayIST(), // always today for the new task, per spec
      status: 'Open',
      suggested: oldTask.suggested,
      sla: oldTask.sla
    },
    userId,
    userRole
  );

  // createTask() already logged "Task created." - add a second entry that
  // links back to the source task, for anyone reviewing history later.
  await query(
    `insert into status_history (task_id, task_uid, user_id, previous_status, new_status, comment)
     values ($1, $2, $3, $4, $4, $5)`,
    [newTask.id, newTask.task_uid, userId, newTask.status, `Reassigned from ${oldTask.task_uid}.${comment ? ' ' + comment : ''}`]
  );

  return newTask;
}

/**
 * Item 2: permanently deletes a task and all its history/sessions
 * (cascade, per the schema). Note: this does not remove the
 * corresponding row from the Google Sheet mirror - the sheet is a
 * one-way mirror and doesn't currently support delete syncing.
 */
async function deleteTask(taskId) {
  const { rows } = await query(`delete from tasks where id = $1 returning id, task_uid`, [taskId]);
  if (rows.length === 0) {
    throw Object.assign(new Error('Task not found.'), { statusCode: 404 });
  }
  return { success: true, taskUid: rows[0].task_uid };
}

/**
 * Item 4: dashboard summary counts. Scoped to a user if userId is given
 * (for "My Tasks" cards), otherwise counts across the whole team.
 */
/**
 * Item 4: current-month scoping. Normal users only see tasks created
 * this calendar month (IST); Master always sees everything. A task
 * currently "Working On" is always included regardless of age, so an
 * older in-progress task never silently disappears from someone's view
 * mid-work (which would also break the break-blocking logic in Item 5/6).
 */
function monthScopeClause(isMaster, alias = 't') {
  if (isMaster) return '';
  return `and ((${alias}.created_at at time zone 'Asia/Kolkata') >= date_trunc('month', now() at time zone 'Asia/Kolkata') or ${alias}.status = 'Working On')`;
}

async function getSummary(userId, isMaster) {
  const whereClause = userId ? 'where t.assigned_user_id = $1' : 'where true';
  const params = userId ? [userId] : [];
  const { rows } = await query(
    `select
       count(*) as total,
       count(*) filter (where status = 'Working On') as working_on,
       count(*) filter (where status = 'Pending') as pending,
       count(*) filter (where status = 'Hold') as hold,
       count(*) filter (where status = 'Done') as done
     from tasks t
     ${whereClause}
     ${monthScopeClause(isMaster)}`,
    params
  );
  const row = rows[0];

  // Item 5: total time spent working on tasks TODAY specifically (not a
  // lifetime total) - summed straight from closed Working On sessions,
  // independent of Today's Working Time (login-based, in activityService).
  let totalWorkingSeconds = 0;
  let scheduledCalls = 0;
  if (userId) {
    const { rows: sessionRows } = await query(
      `select coalesce(sum(duration_seconds), 0) as total
       from status_sessions
       where user_id = $1
         and status = 'Working On'
         and end_time is not null
         and (start_time at time zone 'Asia/Kolkata')::date = $2`,
      [userId, todayIST()]
    );
    totalWorkingSeconds = Number(sessionRows[0].total);

    // Item 3: count of this user's tasks with an upcoming scheduled call.
    const { rows: callRows } = await query(
      `select count(*) as total from tasks where assigned_user_id = $1 and scheduled_call_at is not null`,
      [userId]
    );
    scheduledCalls = Number(callRows[0].total);
  }

  return {
    total: Number(row.total),
    workingOn: Number(row.working_on),
    pending: Number(row.pending),
    hold: Number(row.hold),
    done: Number(row.done),
    totalWorkingSeconds,
    scheduledCalls
  };
}

async function enqueueSync(client, taskId, taskUid, action, payload) {
  await client.query(
    `insert into sync_queue (entity_type, entity_id, task_uid, action, payload)
     values ('task', $1, $2, $3, $4)`,
    [taskId, taskUid, action, JSON.stringify(payload)]
  );
}

async function listMyTasks(userId, isMaster) {
  const { rows } = await query(
    `select t.*, u.full_name as assigned_full_name
     from tasks t
     left join users u on u.id = t.assigned_user_id
     left join dropdown_options d on d.field_name = 'status' and d.value = t.status
     where t.assigned_user_id = $1
     ${monthScopeClause(isMaster)}
     order by
       (t.scheduled_call_at is null) asc,
       t.scheduled_call_at asc,
       coalesce(d.sort_order, 999) asc,
       t.created_at desc`,
    [userId]
  );
  return rows;
}

async function listTeamTasks(isMaster) {
  const { rows } = await query(
    `select t.*, u.full_name as assigned_full_name
     from tasks t
     left join users u on u.id = t.assigned_user_id
     left join dropdown_options d on d.field_name = 'status' and d.value = t.status
     where true
     ${monthScopeClause(isMaster)}
     order by coalesce(d.sort_order, 999) asc, t.created_at desc`
  );
  return rows;
}

async function getTaskDetail(taskId) {
  const { rows: taskRows } = await query(
    `select t.*, u.full_name as assigned_full_name
     from tasks t
     left join users u on u.id = t.assigned_user_id
     where t.id = $1`,
    [taskId]
  );
  const task = taskRows[0];
  if (!task) return null;

  const { rows: history } = await query(
    `select sh.*, u.full_name as user_full_name
     from status_history sh
     left join users u on u.id = sh.user_id
     where sh.task_id = $1
     order by sh.changed_at asc`,
    [taskId]
  );

  const { rows: sessions } = await query(
    `select ss.*, u.full_name as user_full_name
     from status_sessions ss
     left join users u on u.id = ss.user_id
     where ss.task_id = $1
     order by ss.start_time asc`,
    [taskId]
  );

  return { ...task, statusHistory: history, sessions };
}

async function searchTasks(searchQuery, isMaster) {
  const { rows } = await query(
    `select t.*, u.full_name as assigned_full_name
     from tasks t
     left join users u on u.id = t.assigned_user_id
     where (t.task_uid ilike $1
        or t.rest_id ilike $1
        or t.rest_name ilike $1
        or t.email_subject ilike $1
        or t.task_type ilike $1
        or t.related_to ilike $1
        or u.full_name ilike $1)
     ${monthScopeClause(isMaster)}
     order by t.created_at desc
     limit 50`,
    [`%${searchQuery}%`]
  );
  return rows;
}

module.exports = {
  createTask,
  changeStatus,
  updateDashboardStatus,
  updateTaskDetails,
  reassignTask,
  deleteTask,
  getSummary,
  listMyTasks,
  listTeamTasks,
  getTaskDetail,
  searchTasks,
  setScheduledCall
};

/**
 * Item 3: schedules (or clears, if callDate/callTime are null) a call for
 * a task. Stored only as tasks.scheduled_call_at, which is deliberately
 * absent from sheetsSyncService.js's FIELD_TO_HEADER map - so it never
 * gets written to Google Sheets, CRM-only by design. Combining date and
 * time with an explicit +05:30 offset means it's stored correctly
 * regardless of what timezone the database server itself runs in.
 */
async function setScheduledCall(taskId, callDate, callTime) {
  let scheduledCallAt = null;
  if (callDate && callTime) {
    scheduledCallAt = `${callDate}T${callTime}:00+05:30`;
  }

  const { rows } = await query(
    `update tasks set scheduled_call_at = $1, updated_at = now() where id = $2 returning *`,
    [scheduledCallAt, taskId]
  );
  if (rows.length === 0) {
    throw Object.assign(new Error('Task not found.'), { statusCode: 404 });
  }
  return rows[0];
}
