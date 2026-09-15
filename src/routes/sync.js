const express = require('express');
const router = express.Router();
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requireMaster } = require('../middleware/permissions');
const { isConfigured } = require('../services/sheetsClient');

router.use(authenticate, requireMaster);

/**
 * GET /api/sync/queue?status=failed
 * Recent sync queue entries, most recent first. Master-only - this is
 * an operational/debugging view, not something normal users need.
 */
router.get('/queue', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let sql = 'select * from sync_queue';
    if (status) {
      sql += ' where status = $1';
      params.push(status);
    }
    sql += ' order by created_at desc limit 200';
    const { rows } = await query(sql, params);
    res.json({ configured: isConfigured(), items: rows });
  } catch (err) {
    console.error('Sync queue list error:', err);
    res.status(500).json({ error: 'Failed to load sync queue.' });
  }
});

/**
 * POST /api/sync/queue/:id/retry
 * Resets a failed row back to 'pending' so the worker picks it up on its
 * next tick. Attempts counter is reset too, giving it a fresh 5 tries.
 */
router.post('/queue/:id/retry', async (req, res) => {
  try {
    const { rows } = await query(
      `update sync_queue set status = 'pending', attempts = 0, last_error = null where id = $1 returning *`,
      [req.params.id]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Queue entry not found.' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Sync retry error:', err);
    res.status(500).json({ error: 'Failed to retry.' });
  }
});

/**
 * POST /api/sync/resync-all
 * Manual "restore Sheet from CRM" tool. Re-queues every task touched in
 * the last 60 days as an 'update', which the existing worker then writes
 * to the Sheet via syncTask() - that function always looks up the row by
 * Task UID first and overwrites it, only appending if the UID is missing
 * entirely. So this is safe to run any number of times: it never creates
 * duplicate rows, and it never reads the Sheet back into the CRM database
 * - this route only ever SELECTs from tasks, it never writes to them.
 */
router.post('/resync-all', async (req, res) => {
  try {
    const { rows: tasks } = await query(
      `select * from tasks
       where greatest(created_at, updated_at) >= now() - interval '60 days'`
    );

    if (tasks.length === 0) {
      return res.json({ queued: 0, message: 'No tasks found in the last 60 days.' });
    }

    for (const task of tasks) {
      await query(
        `insert into sync_queue (entity_type, entity_id, task_uid, action, payload)
         values ('task', $1, $2, 'update', $3)`,
        [task.id, task.task_uid, JSON.stringify(task)]
      );
    }

    res.json({ queued: tasks.length, message: `${tasks.length} task(s) queued for resync.` });
  } catch (err) {
    console.error('Resync-all error:', err);
    res.status(500).json({ error: 'Failed to queue resync.' });
  }
});

module.exports = router;
