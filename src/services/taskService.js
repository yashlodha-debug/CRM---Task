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

async function enqueueSync(client, taskId, taskUid, action, payload) {
  await client.query(
    `insert into sync_queue (entity_type, entity_id, task_uid, action, payload)
     values ('task', $1, $2, $3, $4)`,
    [taskId, taskUid, action, JSON.stringify(payload)]
  );
}

async function listMyTasks(userId) {
  const { rows } = await query(
    `select t.*, u.full_name as assigned_full_name
     from tasks t
     left join users u on u.id = t.assigned_user_id
     where t.assigned_user_id = $1
     order by t.created_at desc`,
    [userId]
  );
  return rows;
}

async function listTeamTasks() {
  const { rows } = await query(
    `select t.*, u.full_name as assigned_full_name
     from tasks t
     left join users u on u.id = t.assigned_user_id
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

async function searchTasks(searchQuery) {
  const { rows } = await query(
    `select t.*, u.full_name as assigned_full_name
     from tasks t
     left join users u on u.id = t.assigned_user_id
     where t.task_uid ilike $1
        or t.rest_id ilike $1
        or t.rest_name ilike $1
        or t.email_subject ilike $1
        or t.task_type ilike $1
        or t.related_to ilike $1
        or u.full_name ilike $1
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
  listMyTasks,
  listTeamTasks,
  getTaskDetail,
  searchTasks
};
