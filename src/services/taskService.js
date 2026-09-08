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
async function createTask(data, createdByUserId) {
  if (!data.taskType || !data.relatedTo || !data.assignedUserId) {
    throw Object.assign(
      new Error('Task, Related To, and Assigned are required.'),
      { statusCode: 400 }
    );
  }
  if (!data.restId || !String(data.restId).trim() || !data.emailSubject || !String(data.emailSubject).trim()) {
    throw Object.assign(
      new Error('RID and Email Subject are required.'),
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

async function updateTaskDetails(taskId, updates, userId) {
  const providedFields = EDITABLE_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(updates, f));
  if (providedFields.length === 0) {
    throw Object.assign(new Error('No editable fields were provided.'), { statusCode: 400 });
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
 * Item 2: reassign a task to a different user. If the task is currently
 * "Working On", the open session is closed under the outgoing user - the
 * clock does not silently keep running "owned" by someone the task is no
 * longer assigned to. Work resumes fresh (a new session) only when
 * someone actively sets it to Working On again.
 */
async function reassignTask(taskId, newAssignedUserId, userId, comment) {
  if (!newAssignedUserId) {
    throw Object.assign(new Error('newAssignedUserId is required.'), { statusCode: 400 });
  }

  return withTransaction(async (client) => {
    const { rows: taskRows } = await client.query(`select * from tasks where id = $1 for update`, [taskId]);
    const task = taskRows[0];
    if (!task) {
      throw Object.assign(new Error('Task not found.'), { statusCode: 404 });
    }

    if (task.status === WORKING_STATUS) {
      await client.query(
        `update status_sessions
         set end_time = now(), duration_seconds = extract(epoch from (now() - start_time))::int
         where task_id = $1 and end_time is null`,
        [taskId]
      );
    }

    // Recompute the cached total from the sessions themselves, same as
    // changeStatus does - otherwise the just-closed session's time would
    // be recorded in status_sessions but never reflected on tasks.duration_seconds.
    const { rows: durationRows } = await client.query(
      `select coalesce(sum(duration_seconds), 0) as total
       from status_sessions
       where task_id = $1 and status = $2 and end_time is not null`,
      [taskId, WORKING_STATUS]
    );
    const totalDuration = durationRows[0].total;

    const { rows: updatedRows } = await client.query(
      `update tasks set assigned_user_id = $1, duration_seconds = $2, updated_at = now() where id = $3 returning *`,
      [newAssignedUserId, totalDuration, taskId]
    );
    const updatedTask = updatedRows[0];

    await client.query(
      `insert into status_history (task_id, task_uid, user_id, previous_status, new_status, comment)
       values ($1, $2, $3, $4, $4, $5)`,
      [taskId, task.task_uid, userId, task.status, comment || 'Task reassigned.']
    );

    await enqueueSync(client, taskId, task.task_uid, 'update', updatedTask);
    return updatedTask;
  });
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
  return {
    total: Number(row.total),
    workingOn: Number(row.working_on),
    pending: Number(row.pending),
    hold: Number(row.hold),
    done: Number(row.done)
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
     where t.assigned_user_id = $1
     ${monthScopeClause(isMaster)}
     order by t.created_at desc`,
    [userId]
  );
  return rows;
}

async function listTeamTasks(isMaster) {
  const { rows } = await query(
    `select t.*, u.full_name as assigned_full_name
     from tasks t
     left join users u on u.id = t.assigned_user_id
     where true
     ${monthScopeClause(isMaster)}
     order by t.created_at desc`
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
  searchTasks
};
