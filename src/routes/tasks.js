const express = require('express');
const router = express.Router();
const taskService = require('../services/taskService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

// Every route below requires a valid login first.
router.use(authenticate);

/**
 * POST /api/tasks
 * Creates a new task. Requires the 'create_task' permission.
 */
router.post('/', requirePermission('create_task'), async (req, res) => {
  try {
    const task = await taskService.createTask(req.body, req.user.id);
    res.status(201).json(task);
  } catch (err) {
    console.error('Create task error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to create task.' });
  }
});

/**
 * GET /api/tasks/mine
 * "My Tasks" - tasks assigned to the logged-in user.
 */
router.get('/mine', requirePermission('view_my_tasks'), async (req, res) => {
  try {
    const tasks = await taskService.listMyTasks(req.user.id);
    res.json(tasks);
  } catch (err) {
    console.error('List my tasks error:', err);
    res.status(500).json({ error: 'Failed to load your tasks.' });
  }
});

/**
 * GET /api/tasks/team
 * "Team Tasks" - all tasks, full details, read-only unless the user
 * separately has edit permissions (enforced on the write routes below).
 */
router.get('/team', requirePermission('view_team_tasks'), async (req, res) => {
  try {
    const tasks = await taskService.listTeamTasks();
    res.json(tasks);
  } catch (err) {
    console.error('List team tasks error:', err);
    res.status(500).json({ error: 'Failed to load team tasks.' });
  }
});

/**
 * GET /api/tasks/search?q=...
 * Global search across Task UID, Rest ID, Rest Name, Email Subject,
 * Task type, Related To, and Assigned name.
 */
router.get('/search', requirePermission('view_team_tasks'), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const results = await taskService.searchTasks(q);
    res.json(results);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed.' });
  }
});

/**
 * GET /api/tasks/:id
 * Full task details including Status History and Working Session History.
 */
router.get('/:id', async (req, res) => {
  try {
    const task = await taskService.getTaskDetail(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json(task);
  } catch (err) {
    console.error('Get task detail error:', err);
    res.status(500).json({ error: 'Failed to load task.' });
  }
});

/**
 * PATCH /api/tasks/:id/status
 * Body: { newStatus, comment }
 * The comment is mandatory - enforced in taskService, not just here,
 * so it can never be bypassed by calling the API directly.
 */
router.patch('/:id/status', requirePermission('change_status'), async (req, res) => {
  try {
    const { newStatus, comment } = req.body;
    if (!newStatus) {
      return res.status(400).json({ error: 'newStatus is required.' });
    }
    const updated = await taskService.changeStatus(req.params.id, newStatus, comment, req.user.id);
    res.json(updated);
  } catch (err) {
    console.error('Change status error:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to change status.' });
  }
});

module.exports = router;
