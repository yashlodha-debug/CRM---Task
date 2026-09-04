/**
 * Sync queue worker (blueprint section 10/24).
 *
 * Runs on a cron tick (see server.js). Picks up pending sync_queue rows,
 * re-reads the CURRENT state of each task from the database (not the
 * stale snapshot stored when the row was queued - this way, if a task
 * changed twice before the worker got to it, the sheet still ends up
 * showing the latest truth rather than an outdated snapshot), and writes
 * it to the Google Sheet.
 *
 * A Google API outage never blocks the CRM: this worker fails quietly,
 * leaves the row as 'pending', and tries again on the next tick, up to
 * MAX_ATTEMPTS - at which point it's marked 'failed' and surfaced on the
 * admin Sync Monitor screen for manual retry.
 */
const { query } = require('../db/pool');
const { syncTask } = require('./sheetsSyncService');
const { isConfigured } = require('./sheetsClient');

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 10;

async function processQueue() {
  if (!isConfigured()) return; // nothing to do until Google Sheets is set up

  const { rows } = await query(
    `select * from sync_queue
     where status = 'pending' and attempts < $1
     order by created_at asc
     limit $2`,
    [MAX_ATTEMPTS, BATCH_SIZE]
  );

  for (const item of rows) {
    await query(`update sync_queue set status = 'processing' where id = $1`, [item.id]);

    try {
      const { rows: taskRows } = await query(
        `select t.*, u.full_name as assigned_full_name
         from tasks t
         left join users u on u.id = t.assigned_user_id
         where t.id = $1`,
        [item.entity_id]
      );
      const task = taskRows[0];

      if (!task) {
        await markResult(item.id, 'failed', 'Task no longer exists.');
        continue;
      }

      await syncTask(task);
      await markResult(item.id, 'success', null);
    } catch (err) {
      const attempts = item.attempts + 1;
      const finalStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      const message = String(err.message || err).slice(0, 500);

      await query(
        `update sync_queue
         set status = $1, attempts = $2, last_error = $3,
             processed_at = case when $1 = 'failed' then now() else processed_at end
         where id = $4`,
        [finalStatus, attempts, message, item.id]
      );
      await query(
        `insert into sync_log (sync_queue_id, result, response_snippet) values ($1, 'failed', $2)`,
        [item.id, message]
      );
      console.error(`Sync error for ${item.task_uid}:`, message);
    }
  }
}

async function markResult(queueId, status, errorMessage) {
  await query(
    `update sync_queue set status = $1, last_error = $2, processed_at = now() where id = $3`,
    [status, errorMessage, queueId]
  );
  await query(
    `insert into sync_log (sync_queue_id, result, response_snippet) values ($1, $2, $3)`,
    [queueId, status === 'success' ? 'success' : 'failed', errorMessage || 'OK']
  );
}

module.exports = { processQueue };
